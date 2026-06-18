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
  const results = await Promise.all(workers.map((w) => w.run(input)));

  const combined = results
    .map((r, i) => `### Response from ${workers[i].id}\n${r}`)
    .join("\n\n");

  log(`-> [${aggregator.id}] aggregating ${results.length} responses`);
  const aggregated = await aggregator.run(`Original task: ${input}\n\n${combined}`);

  ctx.vars[config.output] = aggregated;
  return ctx;
}
