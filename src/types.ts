import { z } from "zod";

export const LlmConfigSchema = z.object({
  provider: z.literal("anthropic").default("anthropic"),
  model: z.string().default("claude-sonnet-4-6"),
  apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
  maxTokens: z.number().default(2048),
  temperature: z.number().default(1),
});

export const ValidateConfigSchema = z.object({
  // "rule": a JS boolean expression evaluated with `output`, `vars`, `goal` in scope.
  // "llm": an LLM judge call checking `output` against a plain-English `criteria`.
  type: z.enum(["rule", "llm"]).default("rule"),
  rule: z.string().optional(),
  criteria: z.string().optional(),
  maxRetries: z.number().default(0), // re-run the agent with feedback this many times if invalid
  onFail: z.enum(["fail", "warn"]).default("warn"), // behavior once retries are exhausted and still invalid
});

export const AgentConfigSchema = z.object({
  id: z.string(),
  role: z.string().optional(),
  // Short capability blurb. Supervisors render this into the worker roster
  // they show the LLM -- adding agent #51 never touches supervisor logic,
  // it's purely additive config.
  description: z.string().optional(),
  prompt: z.string().optional(), // inline system prompt
  promptFile: z.string().optional(), // path to a prompt file, relative to config file
  model: z.string().optional(), // overrides llm.model for this agent
  isSupervisor: z.boolean().default(false),
  workers: z.array(z.string()).optional(), // worker agent ids (supervisor pattern)
  team: z.array(z.string()).optional(), // nested team member ids (hierarchical pattern)
  // Owned entirely by the agent: a guard condition checked before it runs.
  // The supervisor/orchestrator never decides eligibility -- it just asks,
  // and the framework enforces this gate on the agent's behalf.
  shouldExecute: z.string().optional(), // JS boolean expression, `vars`/`goal` in scope
  // Owned entirely by the agent: validates its own output before it's
  // handed upstream to a caller (supervisor, next pipeline step, aggregator).
  validate: ValidateConfigSchema.optional(),
});

export const StepSchema = z.object({
  agent: z.string(),
  input: z.string(), // template string, e.g. "{{goal}}" or "{{previous_output}}"
  output: z.string(), // variable name to store result under
});

export const LoopConfigSchema = z.object({
  // name of the step (by output var) or list of steps to repeat; if omitted, wraps the whole workflow
  steps: z.array(z.string()).optional(),
  until: z.string(), // JS-like boolean expression evaluated against context, e.g. "vars.review.includes('APPROVED')"
  maxIterations: z.number().default(5),
});

export const WorkflowSchema = z.object({
  steps: z.array(StepSchema).default([]),
  loop: LoopConfigSchema.optional(),
});

export const ParallelConfigSchema = z.object({
  agents: z.array(z.string()), // agent ids to run concurrently
  input: z.string(), // shared input template
  aggregator: z.string(), // agent id that combines results
  output: z.string().default("final_output"),
});

export const SupervisorConfigSchema = z.object({
  supervisor: z.string(), // agent id
  workers: z.array(z.string()),
  input: z.string(),
  maxTurns: z.number().default(10),
  output: z.string().default("final_output"),
});

export const HierarchicalConfigSchema = z.object({
  rootSupervisor: z.string(),
  input: z.string(),
  maxTurns: z.number().default(15),
  output: z.string().default("final_output"),
});

export const PatternEnum = z.enum([
  "sequential",
  "supervisor",
  "parallel",
  "hierarchical",
]);

export const AppConfigSchema = z.object({
  name: z.string(),
  pattern: PatternEnum,
  goal: z.string(),
  llm: LlmConfigSchema.default({}),
  agents: z.array(AgentConfigSchema),
  workflow: WorkflowSchema.optional(), // used by "sequential"
  parallel: ParallelConfigSchema.optional(), // used by "parallel"
  supervisorConfig: SupervisorConfigSchema.optional(), // used by "supervisor"
  hierarchical: HierarchicalConfigSchema.optional(), // used by "hierarchical"
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type ValidateConfig = z.infer<typeof ValidateConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Step = z.infer<typeof StepSchema>;
export type LoopConfig = z.infer<typeof LoopConfigSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ParallelConfig = z.infer<typeof ParallelConfigSchema>;
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;
export type HierarchicalConfig = z.infer<typeof HierarchicalConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export interface RunContext {
  vars: Record<string, string>;
  goal: string;
}
