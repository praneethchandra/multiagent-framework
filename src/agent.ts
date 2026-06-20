import Anthropic from "@anthropic-ai/sdk";
import { AgentConfig, LlmConfig, RunContext, ValidateConfig } from "./types.js";
import { resolvePrompt } from "./configLoader.js";
import { callModel, callSingle } from "./llmClient.js";
import { evalExpr } from "./template.js";
import { trace } from "./trace.js";
import { ToolDef, wrapToolResult } from "./tools.js";

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
  private readonly tools: ToolDef[];
  private readonly maxToolTurns: number;

  constructor(config: AgentConfig, llm: LlmConfig, baseDir: string, toolRegistry: Map<string, ToolDef>) {
    this.id = config.id;
    this.role = config.role ?? config.id;
    this.description = config.description ?? this.role;
    this.systemPrompt = resolvePrompt(baseDir, config);
    this.llm = llm;
    this.modelOverride = config.model;
    this.shouldExecuteExpr = config.shouldExecute;
    this.validateCfg = config.validate;
    // Least privilege (spec #11): resolved strictly from this agent's own
    // allow-list. A tool this agent didn't list is never even constructed
    // into its tool set -- there is no path for it to be called.
    this.tools = config.tools.map((id) => toolRegistry.get(id)!);
    this.maxToolTurns = config.maxToolTurns;
  }

  // Raw, unvalidated, throwing call -- used for protocol-driven control-flow
  // turns (supervisor/team-lead decisions) where there's no caller below to
  // hand a structured error to; a network failure here is a genuine run
  // failure and should propagate to the CLI's top-level error handler.
  // `ctx` is optional only so existing call sites without a token budget to
  // track still compile -- every pattern in this codebase passes it.
  async run(message: string, ctx?: RunContext): Promise<string> {
    const start = Date.now();
    const result = await callSingle(this.llm, this.systemPrompt, message, this.modelOverride);
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

  // The ReAct loop (Thought/Action/Observation): used instead of run() when
  // this agent has tools configured. The model alternates between plain-text
  // reasoning and tool_use requests; each tool result is executed, wrapped
  // as untrusted data, and fed back as an Observation, until the model
  // responds with no further tool calls (Loop-until-Done's exit condition)
  // or maxToolTurns is exhausted (the hard turn budget every loop needs).
  private async runReAct(initialMessage: string, ctx: RunContext, log: (s: string) => void): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: initialMessage }];
    const anthropicTools: Anthropic.Tool[] = this.tools.map((t) => ({
      name: t.id,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    let turn = 0;
    while (turn < this.maxToolTurns) {
      turn++;
      const start = Date.now();
      const result = await callModel(this.llm, this.systemPrompt, messages, this.modelOverride, anthropicTools);
      ctx.tokenUsage.input += result.inputTokens;
      ctx.tokenUsage.output += result.outputTokens;
      trace({
        ts: new Date().toISOString(),
        agentId: this.id,
        event: "call",
        attempt: turn,
        latencyMs: Date.now() - start,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        input: turn === 1 ? initialMessage : "(tool results from previous turn)",
        output: result.text || "(tool call, no text)",
      });

      if (result.toolUses.length === 0) {
        return result.text; // no more actions requested -> done
      }

      messages.push({ role: "assistant", content: result.contentBlocks });

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of result.toolUses) {
        const toolDef = this.tools.find((t) => t.id === toolUse.name);
        const toolStart = Date.now();
        let resultText: string;
        try {
          resultText = toolDef
            ? await toolDef.execute(toolUse.input)
            : `Error: tool "${toolUse.name}" is not available to this agent.`;
        } catch (err) {
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        log(`-- [${this.id}] tool "${toolUse.name}"(${JSON.stringify(toolUse.input)}) -> ${resultText.slice(0, 120)} --`);
        trace({
          ts: new Date().toISOString(),
          agentId: this.id,
          event: "tool",
          latencyMs: Date.now() - toolStart,
          input: `${toolUse.name}(${JSON.stringify(toolUse.input)})`,
          output: resultText,
        });
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          // Prompt-injection defense (spec #10): wrapped as explicit
          // untrusted data, never as an instruction, before re-entering the
          // conversation.
          content: wrapToolResult(toolUse.name, resultText),
        });
      }
      messages.push({ role: "user", content: toolResultBlocks });
    }

    throw new Error(`exceeded maxToolTurns=${this.maxToolTurns} without producing a final answer`);
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
    const result = await callSingle(this.llm, JUDGE_SYSTEM_PROMPT, judgeInput, this.modelOverride);
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
  // handed upstream: shouldExecute gate -> run (ReAct if tools are
  // configured, otherwise a single call) -> validate -> retry-on-fail.
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
        output = this.tools.length > 0 ? await this.runReAct(currentMessage, ctx, log) : await this.run(currentMessage, ctx);
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
  toolRegistry: Map<string, ToolDef>,
): Map<string, Agent> {
  const map = new Map<string, Agent>();
  for (const cfg of agentConfigs) {
    map.set(cfg.id, new Agent(cfg, llm, baseDir, toolRegistry));
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
