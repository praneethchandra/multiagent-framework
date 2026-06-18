import { Agent } from "../agent.js";
import { ParallelConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";

export async function runParallel(
  config: ParallelConfig,
  agents: Map<string, Agent>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const workers = config.agents.map((id) => {
    const a = agents.get(id);
    if (!a) throw new Error(`Unknown agent "${id}" listed under parallel.agents`);
    return a;
  });
  const aggregator = agents.get(config.aggregator);
  if (!aggregator) throw new Error(`Unknown aggregator agent "${config.aggregator}"`);

  const input = renderTemplate(config.input, ctx);
  log(`-> fanning out to [${workers.map((w) => w.id).join(", ")}]`);
  const results = await Promise.all(workers.map((w) => w.execute(ctx, input, log)));

  const usable = results
    .map((r, i) => ({ worker: workers[i], result: r }))
    .filter(({ result }) => !result.skipped);

  if (usable.length === 0) {
    throw new Error(
      `All agents in parallel.agents (${config.agents.join(", ")}) declined to run (shouldExecute=false); nothing to aggregate`,
    );
  }

  const combined = usable.map(({ worker, result }) => `### Response from ${worker.id}\n${result.output}`).join("\n\n");

  log(`-> [${aggregator.id}] aggregating ${usable.length} response(s)`);
  const aggResult = await aggregator.execute(ctx, `Original task: ${input}\n\n${combined}`, log);
  if (aggResult.skipped) {
    throw new Error(`Aggregator "${aggregator.id}" declined to run (shouldExecute=false)`);
  }

  ctx.vars[config.output] = aggResult.output;
  return ctx;
}
