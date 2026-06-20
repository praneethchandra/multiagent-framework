import { AppConfig, RunContext } from "./types.js";
import { buildAgentMap } from "./agent.js";
import { runSequential } from "./patterns/sequential.js";
import { runSupervisor } from "./patterns/supervisor.js";
import { runParallel } from "./patterns/parallel.js";
import { runHierarchical } from "./patterns/hierarchical.js";

export async function runApp(
  config: AppConfig,
  baseDir: string,
  log: (s: string) => void = console.log,
): Promise<RunContext> {
  const agents = buildAgentMap(config.agents, config.llm, baseDir);
  const agentConfigs = new Map(config.agents.map((a) => [a.id, a]));
  const ctx: RunContext = { vars: {}, goal: config.goal, tokenUsage: { input: 0, output: 0 } };

  log(`=== running "${config.name}" (pattern: ${config.pattern}) ===`);

  switch (config.pattern) {
    case "sequential":
      await runSequential(config.workflow!, agents, ctx, log);
      break;
    case "supervisor":
      await runSupervisor(config.supervisorConfig!, agents, ctx, log);
      break;
    case "parallel":
      await runParallel(config.parallel!, agents, ctx, log);
      break;
    case "hierarchical":
      await runHierarchical(config.hierarchical!, agents, agentConfigs, ctx, log);
      break;
  }

  log(`=== done (${ctx.tokenUsage.input + ctx.tokenUsage.output} total tokens: ${ctx.tokenUsage.input} in / ${ctx.tokenUsage.output} out) ===`);
  return ctx;
}
