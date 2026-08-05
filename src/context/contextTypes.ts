// Pure types for the ContextManager + MemoryManager layer.
// No logic, no imports from other framework modules.

export type ContextType =
  | "UserContext"
  | "DomainContext"
  | "SystemContext"
  | "ConversationContext"
  | "RetrievalContext"
  | "TemporalContext"
  | "GraphContext";   // resolved via Knowledge Graph traversal (graphStore:)

export type NodeType = string; // open: Hospital | Doctor | Patient | Room | any domain node

// Open string type: hospital edges plus any domain-specific labels from graphStore:.
export type EdgeLabel = string;

export interface TemporalEdge {
  label: EdgeLabel;
  targetId: string;
  validFrom?: Date;
  validUntil?: Date;
}

export interface ContextNode {
  id: string;
  type: NodeType;
  data: Record<string, unknown>;
  edges: TemporalEdge[];
}

export interface ContextAssembly {
  sections: Map<ContextType, string>;
  totalTokenEstimate: number;
  warnings: string[];
}

export type EventType = "room_change" | "admission" | "discharge" | "transfer" | "doctor_reassignment" | "diagnosis_update";

export interface DomainEvent {
  patientId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
}
