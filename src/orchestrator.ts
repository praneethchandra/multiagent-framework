import { AppConfig, RunContext } from "./types.js";
import { buildAgentMap } from "./agent.js";
import { buildToolRegistry } from "./tools.js";
import { buildRetrievalRegistry } from "./retrieval.js";
import { runSequential, SequentialResumeState } from "./patterns/sequential.js";
import { runSupervisor, SupervisorResumeState } from "./patterns/supervisor.js";
import { runParallel } from "./patterns/parallel.js";
import { runHierarchical } from "./patterns/hierarchical.js";
import { runPlanExecute } from "./patterns/planExecute.js";
import { CheckpointData, loadCheckpoint, makeCheckpointWriter } from "./checkpoint.js";

export interface RunOptions {
  checkpointPath?: string;
  resumePath?: string;
}

export async function runApp(
  config: AppConfig,
  baseDir: string,
  log: (s: string) => void = console.log,
  opts: RunOptions = {},
): Promise<RunContext> {
  const toolRegistry = buildToolRegistry(config.tools, baseDir);
  const retrievalRegistry = buildRetrievalRegistry(config.retrievalStores, baseDir);
  const agents = buildAgentMap(config.agents, config.llm, baseDir, toolRegistry, retrievalRegistry);
  const agentConfigs = new Map(config.agents.map((a) => [a.id, a]));

  // Checkpoint-Resume (spec #3/#4): restore vars/tokenUsage from a prior
  // run's checkpoint if --resume was given, then keep writing fresh
  // checkpoints as this run progresses if --checkpoint was given (they can
  // be the same file, to resume-and-keep-checkpointing in place).
  let resumeData: CheckpointData | null = null;
  if (opts.resumePath) {
    resumeData = loadCheckpoint(opts.resumePath);
    if (!resumeData) {
      log(`-- no checkpoint found at ${opts.resumePath}; starting fresh --`);
    }
  }

  const ctx: RunContext = {
    vars: resumeData?.vars ?? {},
    goal: config.goal,
    tokenUsage: resumeData?.tokenUsage ?? { input: 0, output: 0 },
  };
  const checkpoint = makeCheckpointWriter(opts.checkpointPath, ctx.vars, ctx.tokenUsage);

  log(`=== running "${config.name}" (pattern: ${config.pattern}) ===`);
  if (resumeData) log(`=== resumed from checkpoint: ${opts.resumePath} ===`);

  switch (config.pattern) {
    case "sequential":
      await runSequential(config.workflow!, agents, ctx, log, checkpoint, resumeData?.sequential as SequentialResumeState | undefined);
      break;
    case "supervisor":
      await runSupervisor(config.supervisorConfig!, agents, ctx, log, checkpoint, resumeData?.supervisor as SupervisorResumeState | undefined);
      break;
    case "parallel":
      await runParallel(config.parallel!, agents, ctx, log);
      break;
    case "hierarchical":
      await runHierarchical(config.hierarchical!, agents, agentConfigs, ctx, log, checkpoint);
      break;
    case "plan_execute":
      await runPlanExecute(config.planExecute!, agents, ctx, log);
      break;
  }

  log(`=== done (${ctx.tokenUsage.input + ctx.tokenUsage.output} total tokens: ${ctx.tokenUsage.input} in / ${ctx.tokenUsage.output} out) ===`);
  return ctx;
}
