import { Agent } from "../agent.js";
import { RouterConfig, RouteConfig, RunContext } from "../types.js";
import { renderTemplate } from "../template.js";
import { tokenBaseline, tokensSince } from "../budget.js";
import { runSequential } from "./sequential.js";
import { runSupervisor } from "./supervisor.js";
import { runParallel } from "./parallel.js";
import { runHierarchical } from "./hierarchical.js";
import { runPlanExecute } from "./planExecute.js";

export async function runRouter(
  config: RouterConfig,
  agents: Map<string, Agent>,
  agentConfigs: Map<string, import("../types.js").AgentConfig>,
  ctx: RunContext,
  log: (s: string) => void,
): Promise<void> {
  const baseline = tokenBaseline(ctx);

  // ── Step 1: classify ────────────────────────────────────────────────────
  const classifier = agents.get(config.classifier);
  if (!classifier) {
    throw new Error(`Router classifier agent "${config.classifier}" not found`);
  }

  const classifierInput = renderTemplate(config.input, ctx);
  log(`-- [router] classifying query with agent "${config.classifier}" --`);
  const classResult = await classifier.execute(ctx, classifierInput, log);

  if (classResult.status === "error") {
    throw new Error(`[router] classifier "${config.classifier}" failed: ${classResult.reason}`);
  }

  const routeKey = classResult.output.trim().toLowerCase();
  ctx.vars[config.routeVar] = routeKey;
  log(`-- [router] classifier selected route: "${routeKey}" --`);

  // ── Step 2: resolve route ───────────────────────────────────────────────
  const route: RouteConfig | undefined =
    config.routes[routeKey] ?? config.routes[classResult.output.trim()] ?? config.default;

  if (!route) {
    const available = Object.keys(config.routes).join(", ");
    throw new Error(
      `[router] no route matched "${routeKey}" and no default is configured. ` +
      `Available routes: ${available}`,
    );
  }

  const resolvedKey = config.routes[routeKey]
    ? routeKey
    : config.routes[classResult.output.trim()]
    ? classResult.output.trim()
    : "default";

  log(`-- [router] executing route "${resolvedKey}" (pattern: ${route.pattern}) --`);

  // ── Step 3: dispatch to the selected sub-pattern ────────────────────────
  switch (route.pattern) {
    case "sequential":
      if (!route.workflow) throw new Error(`[router] route "${resolvedKey}" is sequential but has no workflow block`);
      await runSequential(route.workflow, agents, ctx, log);
      break;

    case "supervisor":
      if (!route.supervisorConfig) throw new Error(`[router] route "${resolvedKey}" is supervisor but has no supervisorConfig block`);
      await runSupervisor(route.supervisorConfig, agents, ctx, log);
      break;

    case "parallel":
      if (!route.parallel) throw new Error(`[router] route "${resolvedKey}" is parallel but has no parallel block`);
      await runParallel(route.parallel, agents, ctx, log);
      break;

    case "hierarchical":
      if (!route.hierarchical) throw new Error(`[router] route "${resolvedKey}" is hierarchical but has no hierarchical block`);
      await runHierarchical(route.hierarchical, agents, agentConfigs, ctx, log);
      break;

    case "plan_execute":
      if (!route.planExecute) throw new Error(`[router] route "${resolvedKey}" is plan_execute but has no planExecute block`);
      await runPlanExecute(route.planExecute, agents, ctx, log);
      break;

    default:
      throw new Error(`[router] unsupported sub-pattern in route "${resolvedKey}"`);
  }

  // ── Step 4: token budget enforcement ───────────────────────────────────
  if (config.tokenBudget !== undefined) {
    const spent = tokensSince(ctx, baseline);
    if (spent > config.tokenBudget) {
      log(`-- [router] token budget exceeded: ${spent} > ${config.tokenBudget} --`);
    }
  }

  log(`-- [router] route "${resolvedKey}" complete, output in vars.${config.output} --`);
}
