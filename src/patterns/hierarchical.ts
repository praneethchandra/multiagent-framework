import { Agent } from "../agent.js";
import { AgentConfig, HierarchicalConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { parseDecision } from "../protocol.js";

// Recursively runs a node in the agent hierarchy. Leaf agents (isSupervisor=false)
// just execute the task directly. Supervisor agents delegate to their `team`
// members one turn at a time -- a team member may itself be a supervisor, in
// which case it recurses, enabling arbitrarily nested hierarchies.
async function runNode(
  agentId: string,
  task: string,
  agents: Map<string, Agent>,
  agentConfigs: Map<string, AgentConfig>,
  maxTurns: number,
  log: (s: string) => void,
): Promise<string> {
  const cfg = agentConfigs.get(agentId);
  const agent = agents.get(agentId);
  if (!cfg || !agent) throw new Error(`Unknown agent "${agentId}" in hierarchy`);

  if (!cfg.isSupervisor) {
    log(`-> [${agent.id}] (leaf) executing task`);
    return agent.run(task);
  }

  const team = cfg.team ?? [];
  if (team.length === 0) {
    throw new Error(`Supervisor agent "${agentId}" must define a non-empty "team" list`);
  }

  let transcript = `Task: ${task}\nYour team members: ${team.join(", ")}`;
  let turn = 0;
  while (turn < maxTurns) {
    turn++;
    log(`-- [${agent.id}] supervisor turn ${turn} --`);
    const raw = await agent.run(transcript);
    const decision = parseDecision(raw, "MEMBER");

    if (decision.action === "finish") {
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
        maxTurns,
        log,
      );
      transcript += `\n\n[${decision.target} responded]:\n${memberOutput}`;
      continue;
    }

    throw new Error(`Unknown decision from supervisor "${agentId}": ${decision.action}`);
  }

  throw new Error(`Supervisor "${agentId}" did not finish within maxTurns=${maxTurns}`);
}

export async function runHierarchical(
  config: HierarchicalConfig,
  agents: Map<string, Agent>,
  agentConfigs: Map<string, AgentConfig>,
  ctx: RunContext,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const input = renderTemplate(config.input, ctx);
  const result = await runNode(config.rootSupervisor, input, agents, agentConfigs, config.maxTurns, log);
  ctx.vars[config.output] = result;
  return ctx;
}
