/**
 * Public API surface for the multiagent-framework package.
 *
 * Consumers import from "multiagent-framework", never from internal paths.
 * Internal modules (agent, llmClient, etc.) are not part of the contract.
 */

// ── Core runtime ─────────────────────────────────────────────────────────────
export { runApp }            from "./orchestrator.js";
export type { RunOptions }   from "./orchestrator.js";
export { loadConfig }        from "./configLoader.js";

// ── Types — full schema types for config authoring ───────────────────────────
export type {
  AppConfig,
  AgentConfig,
  LlmConfig,
  RunContext,
  TokenUsage,

  // Workflow / steps
  Workflow,
  Step,
  LoopConfig,

  // Pattern configs
  ParallelConfig,
  SupervisorConfig,
  HierarchicalConfig,
  PlanExecuteConfig,
  RouterConfig,
  RouteConfig,

  // Graph pattern
  AgentGraphConfig,
  AgentGraphNode,
  AgentGraphEdge,

  // Tools + retrieval
  ToolConfig,
  RetrievalStoreConfig,

  // Validation
  ValidateConfig,

  // Context + Memory
  ContextManagerConfig,
  ContextManagerConfigInput,
  MemoryManagerConfig,
  ContextFieldMeta,
  ContextTemplate,
} from "./types.js";

// ── Zod schemas — for consumers who want runtime config validation ────────────
export {
  AppConfigSchema,
  AgentConfigSchema,
  LlmConfigSchema,
  WorkflowSchema,
  StepSchema,
  LoopConfigSchema,
  ParallelConfigSchema,
  SupervisorConfigSchema,
  HierarchicalConfigSchema,
  PlanExecuteConfigSchema,
  RouterConfigSchema,
  RouteSchema,
  AgentGraphConfigSchema,
  AgentGraphNodeSchema,
  AgentGraphEdgeSchema,
  ToolConfigSchema,
  RetrievalStoreConfigSchema,
  ValidateConfigSchema,
  ContextManagerConfigSchema,
  MemoryManagerConfigSchema,
  ContextFieldMetaSchema,
  PatternEnum,
} from "./types.js";

// ── Graph types (context / knowledge graph) ──────────────────────────────────
export type {
  ContextType,
  ContextAssembly,
  ContextNode,
  TemporalEdge,
  DomainEvent,
  EventType,
} from "./context/contextTypes.js";

export { ContextManager }   from "./context/contextManager.js";
export { MemoryManager }    from "./context/memoryManager.js";
export { ContextTree }      from "./context/contextTree.js";
export { GraphStore }       from "./context/graphStore.js";
export { ContextEventBus }  from "./context/contextEventBus.js";
