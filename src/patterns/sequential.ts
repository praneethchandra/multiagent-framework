import { Agent } from "../agent.js";
import { Workflow, RunContext, Step } from "../types.js";
import { renderTemplate, evalCondition } from "../template.js";

async function runStep(step: Step, agents: Map<string, Agent>, ctx: RunContext, log: (s: string) => void) {
  const agent = agents.get(step.agent);
  if (!agent) throw new Error(`Unknown agent "${step.agent}" referenced in workflow step`);
  const input = renderTemplate(step.input, ctx);
  log(`-> [${agent.id}] received input`);
  const result = await agent.execute(ctx, input, log);
  ctx.vars[step.output] = result.skipped ? "" : result.output;
  log(
    result.skipped
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
    let iteration = 0;
    while (iteration < loop.maxIterations) {
      for (const step of loopedSteps) {
        await runStep(step, agents, ctx, log);
      }
      iteration++;
      if (evalCondition(loop.until, ctx)) {
        log(`loop condition met after ${iteration} iteration(s): ${loop.until}`);
        break;
      }
      if (iteration === loop.maxIterations) {
        log(`loop reached maxIterations (${loop.maxIterations}) without satisfying: ${loop.until}`);
      }
    }
  }

  return ctx;
}
