// Pure types for the ContextManager + MemoryManager layer.
// No logic, no imports from other framework modules.

export type ContextType =
  | "UserContext"
  | "DomainContext"
  | "SystemContext"
  | "ConversationContext"
  | "RetrievalContext"
  | "TemporalContext";

export type NodeType = "Hospital" | "Doctor" | "Patient" | "Supervisor" | "Room";

export type EdgeLabel =
  | "has_doctor"
  | "has_patient"
  | "has_supervisor"
  | "has_room"
  | "assigned_to_doctor"
  | "assigned_to_room"
  | "managed_by"
  | "dual_role";

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
