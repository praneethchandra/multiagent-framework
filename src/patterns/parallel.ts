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
  // execute() never throws -- a network blip or validation failure in one
  // worker degrades to a typed "error" result instead of taking down the
  // whole fan-out (Promise.all is safe here precisely because of that).
  const results = await Promise.all(workers.map((w) => w.execute(ctx, input, log)));

  const usable: { worker: Agent; output: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    const { status, output, reason } = results[i];
    if (status === "ok") {
      usable.push({ worker: workers[i], output });
    } else {
      log(`-- [${workers[i].id}] excluded from aggregation (${status}): ${reason} --`);
    }
  }

  if (usable.length === 0) {
    throw new Error(
      `All agents in parallel.agents (${config.agents.join(", ")}) failed or declined to run; nothing to aggregate`,
    );
  }

  const combined = usable.map(({ worker, output }) => `### Response from ${worker.id}\n${output}`).join("\n\n");

  log(`-> [${aggregator.id}] aggregating ${usable.length} response(s)`);
  const aggResult = await aggregator.execute(ctx, `Original task: ${input}\n\n${combined}`, log);
  if (aggResult.status !== "ok") {
    throw new Error(`Aggregator "${aggregator.id}" failed (${aggResult.status}): ${aggResult.reason}`);
  }

  ctx.vars[config.output] = aggResult.output;
  return ctx;
}
