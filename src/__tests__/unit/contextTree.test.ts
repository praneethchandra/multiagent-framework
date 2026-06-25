import { describe, it, expect, beforeEach } from "vitest";
import { ContextTree } from "../../context/contextTree.js";
import type { ContextNode } from "../../context/contextTypes.js";

function makeHospital(): ContextNode {
  return { id: "Hospital:general:t1", type: "Hospital", data: { name: "General" }, edges: [] };
}
function makeDoctor(): ContextNode {
  return { id: "Doctor:dr_smith:t1", type: "Doctor", data: { name: "Dr Smith", license: "MD001" }, edges: [] };
}
function makePatient(room?: string): ContextNode {
  return {
    id: "Patient:p_jones:t1",
    type: "Patient",
    data: { name: "P Jones", patientId: "p_jones" },
    edges: room ? [{ label: "assigned_to_room", targetId: room, validFrom: new Date() }] : [],
  };
}
function makeRoom(id: string): ContextNode {
  return { id, type: "Room", data: { type: "standard" }, edges: [] };
}

describe("ContextTree", () => {
  let tree: ContextTree;

  beforeEach(() => {
    tree = new ContextTree();
  });

  // ── basic add / get ──────────────────────────────────────────────────────

  it("stores and retrieves a node by id", () => {
    const h = makeHospital();
    tree.add(h);
    expect(tree.get("Hospital:general:t1")).toBe(h);
  });

  it("returns undefined for unknown id", () => {
    expect(tree.get("Nobody:x:t1")).toBeUndefined();
  });

  it("overwrites a node on duplicate add", () => {
    tree.add(makeHospital());
    const updated: ContextNode = { id: "Hospital:general:t1", type: "Hospital", data: { name: "Updated" }, edges: [] };
    tree.add(updated);
    expect(tree.get("Hospital:general:t1")!.data.name).toBe("Updated");
  });

  // ── addEdge / getNeighbors ───────────────────────────────────────────────

  it("addEdge creates a directed edge and getNeighbors returns target", () => {
    tree.add(makeHospital());
    tree.add(makeDoctor());
    tree.addEdge("Hospital:general:t1", "has_doctor", "Doctor:dr_smith:t1");
    const neighbors = tree.getNeighbors("Hospital:general:t1", "has_doctor");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe("Doctor:dr_smith:t1");
  });

  it("getNeighbors with no label returns all neighbors", () => {
    tree.add(makeHospital());
    tree.add(makeDoctor());
    tree.add(makePatient());
    tree.addEdge("Hospital:general:t1", "has_doctor", "Doctor:dr_smith:t1");
    tree.addEdge("Hospital:general:t1", "has_patient", "Patient:p_jones:t1");
    expect(tree.getNeighbors("Hospital:general:t1")).toHaveLength(2);
  });

  it("getNeighbors returns empty array for unknown source", () => {
    expect(tree.getNeighbors("Ghost:x:t1")).toEqual([]);
  });

  it("getNeighbors skips edges whose target node is not in the tree", () => {
    tree.add(makeHospital());
    tree.addEdge("Hospital:general:t1", "has_doctor", "Doctor:missing:t1");
    expect(tree.getNeighbors("Hospital:general:t1", "has_doctor")).toHaveLength(0);
  });

  it("cross-refs are pointers: mutating a node is reflected in neighbors", () => {
    const doc = makeDoctor();
    tree.add(makeHospital());
    tree.add(doc);
    tree.addEdge("Hospital:general:t1", "has_doctor", "Doctor:dr_smith:t1");
    doc.data.name = "Dr Jones";
    expect(tree.getNeighbors("Hospital:general:t1", "has_doctor")[0].data.name).toBe("Dr Jones");
  });

  // ── temporal edges ───────────────────────────────────────────────────────

  it("updateEdge with history: current query returns new room", () => {
    const r302 = makeRoom("Room:302:t1");
    const icu = makeRoom("Room:icu:t1");
    const patient = makePatient();
    tree.add(patient);
    tree.add(r302);
    tree.add(icu);

    const t0 = new Date("2025-01-10T08:00:00Z");
    const t1 = new Date("2025-01-12T08:00:00Z");

    tree.addEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1", t0);
    tree.updateEdge("Patient:p_jones:t1", "assigned_to_room", "Room:icu:t1", t1);

    const current = tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room");
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe("Room:icu:t1");
  });

  it("temporal edge: historical query returns old room", () => {
    const r302 = makeRoom("Room:302:t1");
    const icu = makeRoom("Room:icu:t1");
    const patient = makePatient();
    tree.add(patient);
    tree.add(r302);
    tree.add(icu);

    const t0 = new Date("2025-01-10T08:00:00Z");
    const t1 = new Date("2025-01-12T08:00:00Z");

    tree.addEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1", t0);
    tree.updateEdge("Patient:p_jones:t1", "assigned_to_room", "Room:icu:t1", t1);

    const atJan11 = new Date("2025-01-11T08:00:00Z");
    const past = tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room", { at: atJan11 });
    expect(past).toHaveLength(1);
    expect(past[0].id).toBe("Room:302:t1");
  });

  it("addEdge without timestamp: treated as permanent (no validUntil)", () => {
    tree.add(makeHospital());
    tree.add(makeDoctor());
    tree.addEdge("Hospital:general:t1", "has_doctor", "Doctor:dr_smith:t1");
    const far_future = new Date("2099-01-01");
    const neighbors = tree.getNeighbors("Hospital:general:t1", "has_doctor", { at: far_future });
    expect(neighbors).toHaveLength(1);
  });

  // ── serialize ─────────────────────────────────────────────────────────────

  it("serialize returns valid JSON with all node ids", () => {
    tree.add(makeHospital());
    tree.add(makeDoctor());
    const json = tree.serialize();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("Hospital:general:t1");
    expect(parsed).toHaveProperty("Doctor:dr_smith:t1");
  });
});
