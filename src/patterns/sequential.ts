import { Agent } from "../agent.js";
import { Workflow, RunContext, Step } from "../types.js";
import { renderTemplate, evalCondition } from "../template.js";
import { tokenBaseline, tokensSince } from "../budget.js";

async function runStep(step: Step, agents: Map<string, Agent>, ctx: RunContext, log: (s: string) => void) {
  const agent = agents.get(step.agent);
  if (!agent) throw new Error(`Unknown agent "${step.agent}" referenced in workflow step`);
  const input = renderTemplate(step.input, ctx);
  log(`-> [${agent.id}] received input`);
  const result = await agent.execute(ctx, input, log);

  // A fixed pipeline can't meaningfully continue past a failed step -- the
  // next step's input template likely depends on this one's output -- so an
  // "error" status is a hard stop here (unlike supervisor/parallel, which
  // can route around a failure). Surfacing it as a clear thrown error is
  // preferable to silently writing an empty/corrupt value forward.
  if (result.status === "error") {
    throw new Error(`[${agent.id}] step "${step.output}" failed: ${result.reason}`);
  }

  ctx.vars[step.output] = result.status === "skipped" ? "" : result.output;
  log(
    result.status === "skipped"
      ? `<- [${agent.id}] skipped (shouldExecute condition not met)`
      : `<- [${agent.id}] produced "${step.output}" (${result.output.length} chars, ${result.attempts} attempt(s))`,
  );
}

export async function runSequential(
  workflow: Workflow,
  agents: Map<string, Agent>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const allSteps = workflow.steps;
  const loop = workflow.loop;

  // Steps that fall before/after the looped section run exactly once.
  const loopedOutputs = new Set(loop?.steps ?? allSteps.map((s) => s.output));
  const loopedSteps = loop ? allSteps.filter((s) => loopedOutputs.has(s.output)) : [];

  for (const step of allSteps) {
    if (loop && loopedOutputs.has(step.output)) continue; // handled below
    await runStep(step, agents, ctx, log);
  }

  if (loop) {
    // This is the Adversarial-Verify pattern in its general form: a
    // generator/critic (or any) sub-pipeline repeats until `until` is
    // satisfied, bounded by both a turn count (maxIterations) and a token
    // budget -- an unbounded version of this loop is the textbook way a
    // multi-agent system burns cost or hangs indefinitely.
    const startTokens = tokenBaseline(ctx);
    let iteration = 0;
    let exhaustedReason: string | null = null;

    while (iteration < loop.maxIterations) {
      for (const step of loopedSteps) {
        await runStep(step, agents, ctx, log);
      }
      iteration++;

      if (evalCondition(loop.until, ctx)) {
        log(`loop condition met after ${iteration} iteration(s): ${loop.until}`);
        if (loop.statusVar) ctx.vars[loop.statusVar] = "approved";
        exhaustedReason = null;
        break;
      }

      if (loop.tokenBudget && tokensSince(ctx, startTokens) >= loop.tokenBudget) {
        exhaustedReason = `TOKEN_BUDGET_EXCEEDED: spent ${tokensSince(ctx, startTokens)} tokens (budget ${loop.tokenBudget}) without satisfying: ${loop.until}`;
        break;
      }

      if (iteration === loop.maxIterations) {
        exhaustedReason = `MAX_ITERATIONS_EXCEEDED: reached ${loop.maxIterations} iteration(s) without satisfying: ${loop.until}`;
      }
    }

    // Exhaustion (spec #6): surface a structured signal rather than letting
    // the caller mistake "ran out of budget" for "converged." `onExhaustion:
    // fail` treats this as a hard run failure; the default "lastAttempt"
    // keeps the most recent iteration's output (the best available partial
    // result) and proceeds, recording the outcome in `statusVar` if set.
    if (exhaustedReason) {
      log(exhaustedReason);
      if (loop.onExhaustion === "fail") {
        throw new Error(exhaustedReason);
      }
      if (loop.statusVar) ctx.vars[loop.statusVar] = exhaustedReason;
    }
  }

  return ctx;
}
