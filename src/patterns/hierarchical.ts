import { Agent, validateFinish } from "../agent.js";
import { AgentConfig, HierarchicalConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { parseDecision } from "../protocol.js";
import { Transcript } from "../transcript.js";
import { tokenBaseline, tokensSince } from "../budget.js";

function buildRoster(memberIds: string[], agents: Map<string, Agent>): string {
  return memberIds.map((id) => `- ${id}: ${agents.get(id)!.description}`).join("\n");
}

interface BudgetScope {
  startTokens: number; // whole-run baseline; tokenBudget is shared across the entire hierarchy
  tokenBudget?: number;
}

// Recursively runs a node in the agent hierarchy. Leaf agents (isSupervisor=false)
// just execute the task directly (through the shouldExecute/validate pipeline).
// Supervisor agents delegate to their `team` members one turn at a time -- a
// team member may itself be a supervisor, in which case it recurses, enabling
// arbitrarily nested hierarchies. Team rosters are built from config alone,
// so growing a team never touches this routing logic.
async function runNode(
  agentId: string,
  task: string,
  agents: Map<string, Agent>,
  agentConfigs: Map<string, AgentConfig>,
  ctx: RunContext,
  maxTurns: number,
  contextWindowTurns: number,
  budget: BudgetScope,
  log: (s: string) => void,
): Promise<string> {
  const cfg = agentConfigs.get(agentId);
  const agent = agents.get(agentId);
  if (!cfg || !agent) throw new Error(`Unknown agent "${agentId}" in hierarchy`);

  if (!cfg.isSupervisor) {
    const result = await agent.execute(ctx, task, log);
    // Typed handoff (spec #1): a leaf's failure/decline is reported back up
    // as an explicit, labeled string rather than a thrown exception, so the
    // parent supervisor can see it and decide how to proceed.
    if (result.status === "ok") return result.output;
    return `[${agent.id} ${result.status}]: ${result.reason}`;
  }

  const team = cfg.team ?? [];
  if (team.length === 0) {
    throw new Error(`Supervisor agent "${agentId}" must define a non-empty "team" list`);
  }

  const header = `Task: ${task}\nYour team members:\n${buildRoster(team, agents)}`;
  const transcript = new Transcript(header, contextWindowTurns);
  let turn = 0;
  while (turn < maxTurns) {
    if (budget.tokenBudget && tokensSince(ctx, budget.startTokens) >= budget.tokenBudget) {
      const note = `TOKEN_BUDGET_EXCEEDED: supervisor "${agentId}" spent ${tokensSince(ctx, budget.startTokens)} tokens (budget ${budget.tokenBudget}) without finishing.`;
      log(note);
      return `${note}\n\nLast exchange:\n${transcript.tail()}`;
    }

    turn++;
    log(`-- [${agent.id}] supervisor turn ${turn} --`);
    const raw = await agent.run(transcript.render(), ctx);
    const decision = parseDecision(raw, "MEMBER");

    if (decision.action === "finish") {
      const { accept, note } = await validateFinish(agent, ctx, decision.payload, log);
      if (!accept) {
        transcript.add("validation", note);
        continue;
      }
      return decision.payload;
    }

    if (decision.action === "delegate") {
      if (!decision.target || !team.includes(decision.target)) {
        throw new Error(`Supervisor "${agentId}" delegated to a member not in its team: ${decision.target}`);
      }
      const memberOutput = await runNode(
        decision.target,
        decision.payload,
        agents,
        agentConfigs,
        ctx,
        maxTurns,
        contextWindowTurns,
        budget,
        log,
      );
      transcript.add(decision.target, memberOutput);
      continue;
    }

    throw new Error(`Unknown decision from supervisor "${agentId}": ${decision.action}`);
  }

  // Budget-exhaustion (spec #6): return a clearly-marked partial result
  // instead of throwing, so a parent supervisor (or the CLI, at the root)
  // sees exactly what happened rather than the whole run crashing.
  const note = `TURN_BUDGET_EXCEEDED: supervisor "${agentId}" did not finish within maxTurns=${maxTurns}.`;
  log(note);
  return `${note}\n\nLast exchange:\n${transcript.tail()}`;
}

export async function runHierarchical(
  config: HierarchicalConfig,
  agents: Map<string, Agent>,
  agentConfigs: Map<string, AgentConfig>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const input = renderTemplate(config.input, ctx);
  const budget: BudgetScope = { startTokens: tokenBaseline(ctx), tokenBudget: config.tokenBudget };
  const result = await runNode(
    config.rootSupervisor,
    input,
    agents,
    agentConfigs,
    ctx,
    config.maxTurns,
    config.contextWindowTurns,
    budget,
    log,
  );
  ctx.vars[config.output] = result;
  return ctx;
}
