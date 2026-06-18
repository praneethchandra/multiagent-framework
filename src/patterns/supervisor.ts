import { Agent } from "../agent.js";
import { SupervisorConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { parseDecision } from "../protocol.js";

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
  let transcript = `Task: ${initialInput}\nAvailable workers: ${config.workers.join(", ")}`;
  let turn = 0;

  while (turn < config.maxTurns) {
    turn++;
    log(`-- supervisor turn ${turn} --`);
    const raw = await supervisor.run(transcript);
    const decision = parseDecision(raw, "WORKER");

    if (decision.action === "finish") {
      ctx.vars[config.output] = decision.payload;
      log(`supervisor finished after ${turn} turn(s)`);
      return ctx;
    }

    if (decision.action === "call") {
      const worker = decision.target ? agents.get(decision.target) : undefined;
      if (!worker) throw new Error(`Supervisor requested unknown/missing worker: ${decision.target}`);
      log(`-> [${worker.id}] ${decision.payload}`);
      const workerOutput = await worker.run(decision.payload);
      transcript += `\n\n[${worker.id} responded]:\n${workerOutput}`;
      continue;
    }

    throw new Error(`Unknown supervisor action: ${decision.action}`);
  }

  throw new Error(`Supervisor "${config.supervisor}" did not finish within maxTurns=${config.maxTurns}`);
}
