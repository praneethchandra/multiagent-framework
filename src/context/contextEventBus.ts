import type { EventType, DomainEvent } from "./contextTypes.js";
import type { MemoryManager } from "./memoryManager.js";
import type { ContextTree } from "./contextTree.js";

type Listener = (event: DomainEvent) => void;

// Fields to evict per event type.
const EVICT_FIELDS: Record<string, string[]> = {
  room_change:         ["currentRoom", "assignedNurse"],
  admission:           ["admissionStatus", "ward"],
  discharge:           [], // handled specially via evictByPrefix
  transfer:            ["currentUnit", "currentRoom", "attendingDoctor"],
  doctor_reassignment: ["attendingDoctor"],
  diagnosis_update:    ["diagnosisCodes", "treatmentPlan"],
};

export class ContextEventBus {
  private listeners = new Map<string, Listener[]>();

  constructor(
    private readonly mm: MemoryManager,
    private readonly tree: ContextTree,
  ) {
    // Register built-in handlers
    this.on("room_change", (e) => this.handleRoomChange(e));
    this.on("admission",   (e) => this.handleFieldEviction("admission", e));
    this.on("discharge",   (e) => this.handleDischarge(e));
    this.on("transfer",    (e) => this.handleFieldEviction("transfer", e));
    this.on("doctor_reassignment", (e) => this.handleFieldEviction("doctor_reassignment", e));
    this.on("diagnosis_update",    (e) => this.handleFieldEviction("diagnosis_update", e));
  }

  on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...existing, listener]);
  }

  off(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, existing.filter((l) => l !== listener));
  }

  emit(event: EventType | string, payload: DomainEvent): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const l of listeners) l(payload);
  }

  // ── built-in handlers ────────────────────────────────────────────────────

  private handleRoomChange(e: DomainEvent): void {
    const { patientId, tenantId, to } = e;
    if (!patientId || !tenantId) return;

    // Evict warm-tier fields
    for (const field of EVICT_FIELDS["room_change"]) {
      this.mm.evict(`${tenantId}:${patientId}:${field}`);
    }

    // Update context tree edge
    if (to) {
      const nodeId = `Patient:${patientId}:${tenantId}`;
      this.tree.updateEdge(nodeId, "assigned_to_room", String(to));
    }
  }

  private handleFieldEviction(eventType: string, e: DomainEvent): void {
    const { patientId, tenantId } = e;
    if (!patientId || !tenantId) return;
    for (const field of EVICT_FIELDS[eventType] ?? []) {
      this.mm.evict(`${tenantId}:${patientId}:${field}`);
    }
  }

  private handleDischarge(e: DomainEvent): void {
    const { patientId, tenantId } = e;
    if (!patientId || !tenantId) return;
    // Evict ALL warm-tier entries belonging to this patient
    this.mm.evictByPrefix(`${tenantId}:${patientId}:`);
  }
}
