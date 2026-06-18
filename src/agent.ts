import { AgentConfig, LlmConfig, RunContext, ValidateConfig } from "./types.js";
import { resolvePrompt } from "./configLoader.js";
import { callModel } from "./llmClient.js";
import { evalExpr } from "./template.js";

const JUDGE_SYSTEM_PROMPT = `You are a strict QA checker. You are given a set of criteria and a piece of
output to evaluate against them. Respond with exactly "APPROVED" if the
output fully satisfies the criteria. Otherwise respond with "REJECTED: "
followed by a one-sentence reason. Do not include anything else.`;

export interface ExecResult {
  skipped: boolean;
  output: string;
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

  // Raw, unvalidated call -- used for protocol-driven control-flow turns
  // (supervisor/team-lead decisions) where the reply is a routing decision,
  // not a deliverable to validate.
  async run(message: string): Promise<string> {
    return callModel(this.llm, this.systemPrompt, message, this.modelOverride);
  }

  // Whether this agent is willing to run at all, given the current context.
  // The agent owns this decision entirely -- callers (supervisors, pipeline
  // steps) just ask via execute() and get back `skipped: true` if declined.
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

    const verdict = await callModel(
      this.llm,
      JUDGE_SYSTEM_PROMPT,
      `Criteria:\n${this.validateCfg.criteria}\n\nOutput to evaluate:\n${output}`,
      this.modelOverride,
    );
    const ok = verdict.trim().toUpperCase().startsWith("APPROVED");
    return { ok, reason: ok ? "" : verdict.trim() };
  }

  // The full pipeline a "doer" agent goes through before its output is
  // handed upstream: shouldExecute gate -> run -> validate -> retry-on-fail.
  async execute(ctx: RunContext, message: string, log: (s: string) => void = console.log): Promise<ExecResult> {
    if (!this.shouldRun(ctx)) {
      log(`-- [${this.id}] shouldExecute condition not met; skipping --`);
      return { skipped: true, output: "", attempts: 0 };
    }

    const maxRetries = this.validateCfg?.maxRetries ?? 0;
    let currentMessage = message;
    let output = "";
    let attempt = 0;

    while (true) {
      output = await this.run(currentMessage);
      attempt++;
      const { ok, reason } = await this.validateOutput(output, ctx);

      if (ok || attempt > maxRetries) {
        if (!ok) {
          if (this.onFailAction() === "fail") {
            throw new Error(`[${this.id}] output failed validation after ${attempt} attempt(s): ${reason}`);
          }
          log(`-- [${this.id}] WARNING: output failed validation but proceeding (${reason}) --`);
        }
        return { skipped: false, output, attempts: attempt };
      }

      log(`-- [${this.id}] validation failed (attempt ${attempt}/${maxRetries + 1}): ${reason}; retrying --`);
      currentMessage = `${message}\n\nYour previous attempt was rejected: ${reason}\nPlease produce a corrected response.`;
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
