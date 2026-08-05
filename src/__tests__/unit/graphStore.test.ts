import { describe, it, expect } from "vitest";
import { GraphStore } from "../../context/graphStore.js";
import type { GraphStoreConfig } from "../../types.js";

const hospitalConfig: GraphStoreConfig = {
  nodes: [
    { id: "hospital",      type: "Organization", data: { name: "General Hospital" } },
    { id: "patient_jones", type: "Patient",      data: { mrn: "MRN-001", name: "J. Jones" } },
    { id: "room_302",      type: "Room",         data: { number: "302", unit: "general" } },
    { id: "icu_1",         type: "Room",         data: { number: "ICU-1", unit: "critical" } },
    { id: "dr_smith",      type: "Doctor",       data: { licenseId: "MD-9900" } },
  ],
  edges: [
    { from: "hospital",      to: "patient_jones", label: "has_patient" },
    { from: "patient_jones", to: "room_302",      label: "assigned_to_room" },
    { from: "hospital",      to: "dr_smith",      label: "has_doctor" },
    { from: "dr_smith",      to: "patient_jones", label: "treats" },
  ],
};

describe("GraphStore", () => {
  it("single-hop traverse returns target node data", () => {
    const gs = new GraphStore(hospitalConfig);
    const data = gs.traverse("patient_jones", "assigned_to_room");
    expect(data).toEqual({ number: "302", unit: "general" });
  });

  it("multi-hop traverse follows chain of edges", () => {
    const gs = new GraphStore(hospitalConfig);
    const data = gs.traverse("hospital", "has_patient→assigned_to_room");
    expect(data).toEqual({ number: "302", unit: "general" });
  });

  it("returns undefined when start node does not exist", () => {
    const gs = new GraphStore(hospitalConfig);
    expect(gs.traverse("unknown_node", "assigned_to_room")).toBeUndefined();
  });

  it("returns undefined when no edge matches the label", () => {
    const gs = new GraphStore(hospitalConfig);
    expect(gs.traverse("patient_jones", "no_such_edge")).toBeUndefined();
  });

  it("multi-hop returns undefined when intermediate step has no match", () => {
    const gs = new GraphStore(hospitalConfig);
    expect(gs.traverse("hospital", "has_patient→no_such_edge")).toBeUndefined();
  });

  it("get() extracts a specific field from traversal result", () => {
    const gs = new GraphStore(hospitalConfig);
    expect(gs.get("patient_jones", "assigned_to_room", "number")).toBe("302");
    expect(gs.get("patient_jones", "assigned_to_room", "unit")).toBe("general");
  });

  it("get() returns undefined for missing field in traversal result", () => {
    const gs = new GraphStore(hospitalConfig);
    expect(gs.get("patient_jones", "assigned_to_room", "nonexistent")).toBeUndefined();
  });

  it("getTree() returns the underlying ContextTree", () => {
    const gs = new GraphStore(hospitalConfig);
    const tree = gs.getTree();
    expect(tree.get("patient_jones")).toBeDefined();
  });

  it("handles empty node/edge config gracefully", () => {
    const gs = new GraphStore({ nodes: [], edges: [] });
    expect(gs.traverse("any", "any_edge")).toBeUndefined();
  });

  it("temporal edges with validFrom/validUntil are respected", () => {
    const cfg: GraphStoreConfig = {
      nodes: [
        { id: "patient_a", type: "Patient", data: {} },
        { id: "room_old",  type: "Room",    data: { number: "101" } },
        { id: "room_icu",  type: "Room",    data: { number: "ICU-2" } },
      ],
      edges: [
        {
          from: "patient_a", to: "room_old", label: "assigned_to_room",
          validFrom: "2025-01-01", validUntil: "2025-01-15",
        },
        {
          from: "patient_a", to: "room_icu", label: "assigned_to_room",
          validFrom: "2025-01-15",
        },
      ],
    };
    const gs = new GraphStore(cfg);
    // Current assignment (no validUntil on the ICU edge) should be ICU
    const data = gs.traverse("patient_a", "assigned_to_room");
    expect(data).toEqual({ number: "ICU-2" });
  });
});
