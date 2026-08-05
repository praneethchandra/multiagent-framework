import type { GraphStoreConfig } from "../types.js";
import { ContextTree } from "./contextTree.js";

// Knowledge Graph: a pre-seeded ContextTree that can be traversed by
// path expressions like "patient_jones→assigned_to_room→unit".
// Distinct from Agent Graphs (how work moves) — this models how data connects.
export class GraphStore {
  private readonly tree: ContextTree;

  constructor(config: GraphStoreConfig) {
    this.tree = new ContextTree();
    for (const node of config.nodes) {
      this.tree.add({ id: node.id, type: node.type, data: node.data, edges: [] });
    }
    for (const edge of config.edges) {
      const validFrom  = edge.validFrom  ? new Date(edge.validFrom)  : undefined;
      const validUntil = edge.validUntil ? new Date(edge.validUntil) : undefined;
      if (validUntil !== undefined) {
        // Closed (historical) edge: add directly to the node's edge list
        // so it doesn't overwrite the current open edge.
        const node = this.tree.get(edge.from);
        if (node) node.edges.push({ label: edge.label, targetId: edge.to, validFrom, validUntil });
      } else {
        // Open (current) edge: use updateEdge to close any previous open edge with the same label.
        this.tree.updateEdge(edge.from, edge.label, edge.to, validFrom ?? new Date(0));
      }
    }
  }

  // Traverse a "→"-separated path from a start node.
  // "patient_jones→assigned_to_room" → data of the target node.
  // "hospital→has_patient→assigned_to_room" → multi-hop.
  // Returns undefined if any step has no matching neighbor.
  traverse(startId: string, path: string): Record<string, unknown> | undefined {
    const segments = path.split("→").filter(Boolean);
    let currentId = startId;

    for (const label of segments) {
      const neighbors = this.tree.getNeighbors(currentId, label);
      if (neighbors.length === 0) return undefined;
      currentId = neighbors[0].id;
    }

    return this.tree.get(currentId)?.data;
  }

  // Convenience: get a single data field from a traversal result.
  // e.g. get("patient_jones", "assigned_to_room", "number") → "302"
  get(startId: string, path: string, field: string): string | undefined {
    const data = this.traverse(startId, path);
    const val = data?.[field];
    return val != null ? String(val) : undefined;
  }

  getTree(): ContextTree {
    return this.tree;
  }
}
