import { Agent, validateFinish } from "../agent.js";
import { SupervisorConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { parseDecision } from "../protocol.js";
import { Transcript } from "../transcript.js";
import { tokenBaseline, tokensSince } from "../budget.js";

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
  const header = `Task: ${initialInput}\nAvailable workers:\n${buildRoster(config.workers, agents)}`;
  const transcript = new Transcript(header, config.contextWindowTurns);
  const startTokens = tokenBaseline(ctx);
  let turn = 0;

  while (turn < config.maxTurns) {
    if (config.tokenBudget && tokensSince(ctx, startTokens) >= config.tokenBudget) {
      const note = `TOKEN_BUDGET_EXCEEDED: supervisor "${config.supervisor}" spent ${tokensSince(ctx, startTokens)} tokens (budget ${config.tokenBudget}) without finishing.`;
      log(note);
      ctx.vars[config.output] = `${note}\n\nLast exchange:\n${transcript.tail()}`;
      return ctx;
    }

    turn++;
    log(`-- supervisor turn ${turn} --`);
    const raw = await supervisor.run(transcript.render(), ctx);
    const decision = parseDecision(raw, "WORKER");

    if (decision.action === "finish") {
      const { accept, note } = await validateFinish(supervisor, ctx, decision.payload, log);
      if (!accept) {
        transcript.add("validation", note);
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

      // Typed handoff status (spec #1 / anti-pattern 5.6): the supervisor
      // always sees an explicit ok/skipped/error signal for what happened,
      // never a silent success or a crashed run, and can route around it
      // (try a different worker, retry, or give up) using its own judgment.
      if (result.status === "ok") {
        transcript.add(worker.id, result.output);
      } else if (result.status === "skipped") {
        transcript.add(worker.id, `[declined]: ${result.reason}`);
      } else {
        transcript.add(worker.id, `[error]: ${result.reason}. Its output (if any) should not be trusted.`);
      }
      continue;
    }

    throw new Error(`Unknown supervisor action: ${decision.action}`);
  }

  // Budget-exhaustion (spec #6): surface a structured, clearly-marked signal
  // and the best available partial state instead of throwing and losing the
  // whole run, or silently returning something that looks like success.
  const note = `TURN_BUDGET_EXCEEDED: supervisor "${config.supervisor}" did not finish within maxTurns=${config.maxTurns}.`;
  log(note);
  ctx.vars[config.output] = `${note}\n\nLast exchange:\n${transcript.tail()}`;
  return ctx;
}
