import { z } from "zod";
import { Agent } from "../agent.js";
import { PlanExecuteConfig, RunContext, StepSchema } from "../types.js";
import { renderTemplate } from "../template.js";
import { runStep } from "./sequential.js";

const PlanSchema = z.object({ steps: z.array(StepSchema) });

function buildRoster(agentIds: string[], agents: Map<string, Agent>): string {
  return agentIds.map((id) => `- ${id}: ${agents.get(id)!.description}`).join("\n");
}

// Dynamic Plan-then-Execute: the planner produces a step list at runtime
// instead of it being hand-authored in workflow.steps, then that plan is
// executed by the exact same step-runner sequential uses. The plan is a
// typed handoff (spec #1) -- parsed and schema-validated before a single
// step of it runs; a malformed or out-of-bounds plan is rejected with a
// clear error rather than silently executed.
export async function runPlanExecute(
  config: PlanExecuteConfig,
  agents: Map<string, Agent>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const planner = agents.get(config.planner);
  if (!planner) throw new Error(`Unknown planner agent "${config.planner}"`);
  for (const id of config.executorAgents) {
    if (!agents.has(id)) throw new Error(`Unknown executor agent "${id}" listed under planExecute.executorAgents`);
  }

  const input = renderTemplate(config.input, ctx);
  const prompt = `Task: ${input}\nAvailable agents:\n${buildRoster(config.executorAgents, agents)}`;
  log(`-> [${planner.id}] generating plan`);
  const raw = await planner.run(prompt, ctx);

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Planner "${config.planner}" did not return a JSON plan. Got:\n${raw}`);
  }

  let plan: z.infer<typeof PlanSchema>;
  try {
    plan = PlanSchema.parse(JSON.parse(match[0]));
  } catch (err) {
    throw new Error(
      `Planner "${config.planner}" produced an invalid plan (${err instanceof Error ? err.message : err}). Got:\n${raw}`,
    );
  }

  if (plan.steps.length === 0) {
    throw new Error(`Planner "${config.planner}" produced an empty plan`);
  }
  if (plan.steps.length > config.maxSteps) {
    throw new Error(`Planner "${config.planner}" produced ${plan.steps.length} steps, exceeding maxSteps=${config.maxSteps}`);
  }
  for (const step of plan.steps) {
    if (!config.executorAgents.includes(step.agent)) {
      throw new Error(
        `Planner "${config.planner}" referenced agent "${step.agent}" which is not in executorAgents -- refusing to execute an unvetted plan`,
      );
    }
  }

  log(`plan accepted: ${plan.steps.map((s) => `${s.agent}->${s.output}`).join(" => ")}`);

  for (const step of plan.steps) {
    await runStep(step, agents, ctx, log);
  }

  const lastStep = plan.steps[plan.steps.length - 1];
  ctx.vars[config.output] = ctx.vars[lastStep.output] ?? "";
  return ctx;
}
