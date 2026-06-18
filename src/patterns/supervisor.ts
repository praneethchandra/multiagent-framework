import { Agent, validateFinish } from "../agent.js";
import { SupervisorConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { parseDecision } from "../protocol.js";

// Builds the worker roster purely from config (id + description) -- the
// supervisor's prompt and this code never hardcode which agents exist or
// what they're for. Adding worker #51 is just another agents[] entry; the
// supervisor selects between them via its own LLM judgment, not branching
// logic here.
function buildRoster(workerIds: string[], agents: Map<string, Agent>): string {
  return workerIds.map((id) => `- ${id}: ${agents.get(id)!.description}`).join("\n");
}

export async function runSupervisor(
  config: SupervisorConfig,
  agents: Map<string, Agent>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const supervisor = agents.get(config.supervisor);
  if (!supervisor) throw new Error(`Unknown supervisor agent "${config.supervisor}"`);
  for (const id of config.workers) {
    if (!agents.has(id)) throw new Error(`Unknown worker agent "${id}" listed under supervisorConfig.workers`);
  }

  const initialInput = renderTemplate(config.input, ctx);
  let transcript = `Task: ${initialInput}\nAvailable workers:\n${buildRoster(config.workers, agents)}`;
  let turn = 0;

  while (turn < config.maxTurns) {
    turn++;
    log(`-- supervisor turn ${turn} --`);
    const raw = await supervisor.run(transcript);
    const decision = parseDecision(raw, "WORKER");

    if (decision.action === "finish") {
      const { accept, note } = await validateFinish(supervisor, ctx, decision.payload, log);
      if (!accept) {
        transcript += note;
        continue;
      }
      ctx.vars[config.output] = decision.payload;
      log(`supervisor finished after ${turn} turn(s)`);
      return ctx;
    }

    if (decision.action === "call") {
      const worker = decision.target ? agents.get(decision.target) : undefined;
      if (!worker) throw new Error(`Supervisor requested unknown/missing worker: ${decision.target}`);
      log(`-> [${worker.id}] ${decision.payload}`);
      const result = await worker.execute(ctx, decision.payload, log);
      transcript += result.skipped
        ? `\n\n[${worker.id} declined]: its shouldExecute condition was not met for this request.`
        : `\n\n[${worker.id} responded]:\n${result.output}`;
      continue;
    }

    throw new Error(`Unknown supervisor action: ${decision.action}`);
  }

  throw new Error(`Supervisor "${config.supervisor}" did not finish within maxTurns=${config.maxTurns}`);
}
