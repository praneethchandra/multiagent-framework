import type { AgentGraphConfig, RunContext } from "../types.js";
import type { Agent } from "../agent.js";
import { renderTemplate } from "../template.js";
import { askHuman } from "../humanInput.js";

// Normalize from/to to always be string[].
function toArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

// Evaluate a JS boolean expression with vars and goal in scope.
function evalWhen(expr: string, ctx: RunContext): boolean {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("vars", "goal", `return !!(${expr});`);
    return fn(ctx.vars, ctx.goal) as boolean;
  } catch {
    return false;
  }
}

export async function runGraph(
  config: AgentGraphConfig,
  agents: Map<string, Agent>,
  ctx: RunContext,
  log: (s: string) => void,
): Promise<void> {
  const nodeMap = new Map(config.nodes.map(n => [n.id, n]));

  // Build predecessor + incoming-edge maps for topological execution.
  const predecessors = new Map<string, Set<string>>(
    config.nodes.map(n => [n.id, new Set<string>()])
  );
  // Map from nodeId → all edges that terminate at that node.
  const incomingEdges = new Map<string, Array<{ fromList: string[]; type: string; when?: string }>>(
    config.nodes.map(n => [n.id, []])
  );

  for (const edge of config.edges) {
    const fromList = toArray(edge.from);
    const toList   = toArray(edge.to);
    for (const f of fromList) {
      for (const t of toList) {
        predecessors.get(t)?.add(f);
        incomingEdges.get(t)?.push({ fromList, type: edge.type, when: edge.when });
      }
    }
  }

  const completed = new Set<string>();
  const skipped   = new Set<string>();

  // Seed ready queue with root nodes (no predecessors).
  const ready: string[] = [];
  for (const [id, preds] of predecessors) {
    if (preds.size === 0) ready.push(id);
  }

  let turnCount = 0;

  while (ready.length > 0) {
    // Execute all currently-ready nodes as a concurrent batch.
    const batch = ready.splice(0, ready.length);

    await Promise.all(batch.map(async (nodeId) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      // Determine if this node should be skipped.
      let shouldSkip = false;
      for (const inc of incomingEdges.get(nodeId) ?? []) {
        // If every predecessor of this incoming edge is skipped, skip this node too.
        if (inc.fromList.every(f => skipped.has(f))) {
          shouldSkip = true;
          break;
        }
        // Conditional edge: evaluate when expression.
        if (inc.type === "conditional" && inc.when) {
          if (!evalWhen(inc.when, ctx)) {
            shouldSkip = true;
            break;
          }
        }
      }

      if (shouldSkip) {
        log(`-- [graph] skip "${nodeId}" (condition not met or predecessors skipped) --`);
        skipped.add(nodeId);
        completed.add(nodeId);
        return;
      }

      if (turnCount >= config.maxTurns) {
        log(`-- [graph] TURN_BUDGET_EXCEEDED: reached maxTurns=${config.maxTurns}, skipping "${nodeId}" --`);
        skipped.add(nodeId);
        completed.add(nodeId);
        return;
      }

      turnCount++;
      const input = renderTemplate(node.input, ctx);
      log(`-- [graph] run "${nodeId}" (${node.type}) --`);

      if (node.type === "human_gate") {
        const answer = await askHuman(input);
        ctx.vars[node.output] = answer;
        log(`-- [graph] human gate "${nodeId}" answered --`);
      } else {
        const agent = node.agentId ? agents.get(node.agentId) : undefined;
        if (!agent) {
          log(`-- [graph] WARNING: no agent "${node.agentId}" for node "${nodeId}" --`);
        } else {
          const result = await agent.execute(ctx, input, log);
          ctx.vars[node.output] = result.output ?? "";
          if (result.status !== "ok") {
            log(`-- [graph] node "${nodeId}" ${result.status}: ${result.reason ?? ""} --`);
          }
        }
      }

      completed.add(nodeId);
    }));

    // Enqueue nodes whose every predecessor is now complete.
    for (const [id, preds] of predecessors) {
      if (!completed.has(id) && !skipped.has(id) && !ready.includes(id)) {
        if ([...preds].every(p => completed.has(p))) {
          ready.push(id);
        }
      }
    }
  }

  // Warn on missing stateSchema keys.
  if (config.stateSchema) {
    for (const key of Object.keys(config.stateSchema)) {
      if (!(key in ctx.vars)) {
        log(`-- [graph] WARNING: expected state key "${key}" not in vars after graph execution --`);
      }
    }
  }

  log(`-- [graph] done (${turnCount} turns) --`);
}
