import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextEventBus } from "../../context/contextEventBus.js";
import { MemoryManager } from "../../context/memoryManager.js";
import { ContextTree } from "../../context/contextTree.js";
import type { ContextNode } from "../../context/contextTypes.js";

function makeMgr() {
  return new MemoryManager({ warmTierMaxEntries: 100, defaultTtlSeconds: 300, accessCountThreshold: 3 });
}

function makePatientNode(): ContextNode {
  return { id: "Patient:p_jones:t1", type: "Patient", data: {}, edges: [] };
}
function makeRoomNode(id: string): ContextNode {
  return { id, type: "Room", data: {}, edges: [] };
}

describe("ContextEventBus", () => {
  let bus: ContextEventBus;
  let mm: MemoryManager;
  let tree: ContextTree;

  beforeEach(() => {
    mm = makeMgr();
    tree = new ContextTree();
    bus = new ContextEventBus(mm, tree);
  });

  // ── registration / emit ──────────────────────────────────────────────────

  it("calls a registered listener on emit", () => {
    const fn = vi.fn();
    bus.on("room_change", fn);
    bus.emit("room_change", { patientId: "p_jones", from: "302", to: "ICU", tenantId: "t1" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("calls multiple listeners for the same event", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on("room_change", fn1);
    bus.on("room_change", fn2);
    bus.emit("room_change", {});
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("emit with unknown event type is a no-op (no throw)", () => {
    expect(() => bus.emit("unknown_event" as any, {})).not.toThrow();
  });

  it("off() removes a listener", () => {
    const fn = vi.fn();
    bus.on("room_change", fn);
    bus.off("room_change", fn);
    bus.emit("room_change", {});
    expect(fn).not.toHaveBeenCalled();
  });

  // ── room_change evicts warm tier ─────────────────────────────────────────

  it("room_change evicts currentRoom from warm tier", () => {
    mm.set("t1:p_jones:currentRoom", "Room:302:t1", 300);
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    expect(mm.get("t1:p_jones:currentRoom")).toBeUndefined();
  });

  it("room_change evicts assignedNurse from warm tier", () => {
    mm.set("t1:p_jones:assignedNurse", "Nurse A", 300);
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    expect(mm.get("t1:p_jones:assignedNurse")).toBeUndefined();
  });

  it("room_change does NOT evict unrelated fields", () => {
    mm.set("t1:p_jones:allergies", "penicillin", 300);
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    expect(mm.get("t1:p_jones:allergies")).toBe("penicillin");
  });

  // ── room_change updates context tree ────────────────────────────────────

  it("room_change updates assigned_to_room edge in context tree", () => {
    const patient = makePatientNode();
    const r302 = makeRoomNode("Room:302:t1");
    const icu = makeRoomNode("Room:icu:t1");
    tree.add(patient);
    tree.add(r302);
    tree.add(icu);
    tree.addEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1");

    bus.emit("room_change", {
      patientId: "p_jones",
      from: "Room:302:t1",
      to: "Room:icu:t1",
      tenantId: "t1",
    });

    const current = tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room");
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe("Room:icu:t1");
  });

  // ── admission event ──────────────────────────────────────────────────────

  it("admission evicts admissionStatus from warm tier", () => {
    mm.set("t1:p_jones:admissionStatus", "pending", 300);
    bus.emit("admission", { patientId: "p_jones", tenantId: "t1" });
    expect(mm.get("t1:p_jones:admissionStatus")).toBeUndefined();
  });

  // ── discharge event ──────────────────────────────────────────────────────

  it("discharge evicts all patient fields matching that patient", () => {
    mm.set("t1:p_jones:currentRoom", "Room:302:t1", 300);
    mm.set("t1:p_jones:admissionStatus", "admitted", 300);
    mm.set("t1:other_patient:currentRoom", "Room:201:t1", 300);
    bus.emit("discharge", { patientId: "p_jones", tenantId: "t1" });
    expect(mm.get("t1:p_jones:currentRoom")).toBeUndefined();
    expect(mm.get("t1:p_jones:admissionStatus")).toBeUndefined();
    // other patient unaffected
    expect(mm.get("t1:other_patient:currentRoom")).toBe("Room:201:t1");
  });
});
