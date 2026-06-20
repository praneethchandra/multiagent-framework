import { AgentConfig, LlmConfig, RunContext, ValidateConfig } from "./types.js";
import { resolvePrompt } from "./configLoader.js";
import { callModel } from "./llmClient.js";
import { evalExpr } from "./template.js";
import { trace } from "./trace.js";

const JUDGE_SYSTEM_PROMPT = `You are a strict QA checker. You are given a set of criteria and a piece of
output to evaluate against them. Respond with exactly "APPROVED" if the
output fully satisfies the criteria. Otherwise respond with "REJECTED: "
followed by a one-sentence reason. Do not include anything else.`;

// Typed handoff status (spec #1 / anti-pattern 5.6 "silent failures between
// agents"): a caller (supervisor, pipeline step, aggregator) always gets back
// one of these three states instead of an agent's run silently succeeding,
// silently producing garbage, or throwing and killing the whole orchestration.
// "error" covers both validation failures (onFail: fail) and unexpected
// runtime failures (network errors, etc.) -- execute() never throws.
export type ExecStatus = "ok" | "skipped" | "error";

export interface ExecResult {
  status: ExecStatus;
  output: string;
  reason?: string; // present when status is "skipped" or "error"
  attempts: number;
}

export class Agent {
  readonly id: string;
  readonly role: string;
  readonly description: string;
  readonly systemPrompt: string;
  private readonly llm: LlmConfig;
  private readonly modelOverride?: string;
  private readonly shouldExecuteExpr?: string;
  private readonly validateCfg?: ValidateConfig;

  constructor(config: AgentConfig, llm: LlmConfig, baseDir: string) {
    this.id = config.id;
    this.role = config.role ?? config.id;
    this.description = config.description ?? this.role;
    this.systemPrompt = resolvePrompt(baseDir, config);
    this.llm = llm;
    this.modelOverride = config.model;
    this.shouldExecuteExpr = config.shouldExecute;
    this.validateCfg = config.validate;
  }

  // Raw, unvalidated, throwing call -- used for protocol-driven control-flow
  // turns (supervisor/team-lead decisions) where there's no caller below to
  // hand a structured error to; a network failure here is a genuine run
  // failure and should propagate to the CLI's top-level error handler.
  // `ctx` is optional only so existing call sites without a token budget to
  // track still compile -- every pattern in this codebase passes it.
  async run(message: string, ctx?: RunContext): Promise<string> {
    const start = Date.now();
    const result = await callModel(this.llm, this.systemPrompt, message, this.modelOverride);
    if (ctx) {
      ctx.tokenUsage.input += result.inputTokens;
      ctx.tokenUsage.output += result.outputTokens;
    }
    trace({
      ts: new Date().toISOString(),
      agentId: this.id,
      event: "call",
      latencyMs: Date.now() - start,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      input: message,
      output: result.text,
    });
    return result.text;
  }

  // Whether this agent is willing to run at all, given the current context.
  // The agent owns this decision entirely -- callers just ask via execute()
  // and get back `status: "skipped"` if declined.
  shouldRun(ctx: RunContext): boolean {
    if (!this.shouldExecuteExpr) return true;
    return Boolean(evalExpr(this.shouldExecuteExpr, { vars: ctx.vars, goal: ctx.goal }));
  }

  hasValidation(): boolean {
    return Boolean(this.validateCfg);
  }

  onFailAction(): "fail" | "warn" {
    return this.validateCfg?.onFail ?? "warn";
  }

  // Checks `output` against this agent's own validate config, if any. An
  // agent with no validate config always passes -- validation is opt-in per
  // agent, never imposed by the caller.
  async validateOutput(output: string, ctx: RunContext): Promise<{ ok: boolean; reason: string }> {
    if (!this.validateCfg) return { ok: true, reason: "" };

    if (this.validateCfg.type === "rule") {
      const ok = Boolean(evalExpr(this.validateCfg.rule!, { output, vars: ctx.vars, goal: ctx.goal }));
      return { ok, reason: ok ? "" : `did not satisfy rule: ${this.validateCfg.rule}` };
    }

    const start = Date.now();
    const judgeInput = `Criteria:\n${this.validateCfg.criteria}\n\nOutput to evaluate:\n${output}`;
    const result = await callModel(this.llm, JUDGE_SYSTEM_PROMPT, judgeInput, this.modelOverride);
    ctx.tokenUsage.input += result.inputTokens;
    ctx.tokenUsage.output += result.outputTokens;
    trace({
      ts: new Date().toISOString(),
      agentId: this.id,
      event: "validate",
      latencyMs: Date.now() - start,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      input: judgeInput,
      output: result.text,
    });
    const ok = result.text.trim().toUpperCase().startsWith("APPROVED");
    return { ok, reason: ok ? "" : result.text.trim() };
  }

  // The full pipeline a "doer" agent goes through before its output is
  // handed upstream: shouldExecute gate -> run -> validate -> retry-on-fail.
  // Never throws -- every failure mode (decline, validation failure, or an
  // unexpected runtime error) comes back as a typed ExecResult so the caller
  // can react instead of crashing the whole orchestration.
  async execute(ctx: RunContext, message: string, log: (s: string) => void = console.log): Promise<ExecResult> {
    if (!this.shouldRun(ctx)) {
      log(`-- [${this.id}] shouldExecute condition not met; skipping --`);
      return { status: "skipped", output: "", reason: "shouldExecute condition not met", attempts: 0 };
    }

    try {
      const maxRetries = this.validateCfg?.maxRetries ?? 0;
      let currentMessage = message;
      let output = "";
      let attempt = 0;

      while (true) {
        output = await this.run(currentMessage, ctx);
        attempt++;
        const { ok, reason } = await this.validateOutput(output, ctx);

        if (ok || attempt > maxRetries) {
          if (!ok) {
            if (this.onFailAction() === "fail") {
              return { status: "error", output, reason: `validation failed: ${reason}`, attempts: attempt };
            }
            log(`-- [${this.id}] WARNING: output failed validation but proceeding (${reason}) --`);
          }
          return { status: "ok", output, attempts: attempt };
        }

        log(`-- [${this.id}] validation failed (attempt ${attempt}/${maxRetries + 1}): ${reason}; retrying --`);
        currentMessage = `${message}\n\nYour previous attempt was rejected: ${reason}\nPlease produce a corrected response.`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`-- [${this.id}] ERROR: ${reason} --`);
      return { status: "error", output: "", reason, attempts: 0 };
    }
  }
}

export function buildAgentMap(
  agentConfigs: AgentConfig[],
  llm: LlmConfig,
  baseDir: string,
): Map<string, Agent> {
  const map = new Map<string, Agent>();
  for (const cfg of agentConfigs) {
    map.set(cfg.id, new Agent(cfg, llm, baseDir));
  }
  return map;
}

// Shared by supervisor/hierarchical patterns: validates a "finish" payload
// against the deciding agent's own validate config. If it fails and onFail
// is "fail", returns a feedback note to push back into the conversation
// instead of accepting the finish -- this consumes a turn against the
// existing maxTurns budget rather than introducing a separate retry counter.
export async function validateFinish(
  agent: Agent,
  ctx: RunContext,
  payload: string,
  log: (s: string) => void,
): Promise<{ accept: boolean; note: string }> {
  if (!agent.hasValidation()) return { accept: true, note: "" };

  const { ok, reason } = await agent.validateOutput(payload, ctx);
  if (ok) return { accept: true, note: "" };

  if (agent.onFailAction() === "fail") {
    log(`-- [${agent.id}] finish rejected by validation: ${reason} --`);
    return {
      accept: false,
      note: `\n\n[validation rejected your finish]: ${reason}\nPlease address this and try again.`,
    };
  }

  log(`-- [${agent.id}] WARNING: finish failed validation but accepting (${reason}) --`);
  return { accept: true, note: "" };
}
