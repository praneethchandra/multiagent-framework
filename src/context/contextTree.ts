import type { ContextNode, EdgeLabel, TemporalEdge } from "./contextTypes.js";

export interface GetNeighborsOptions {
  at?: Date;
}

export class ContextTree {
  private nodes = new Map<string, ContextNode>();

  add(node: ContextNode): void {
    this.nodes.set(node.id, node);
  }

  get(id: string): ContextNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Add an edge from sourceId to targetId.
   * validFrom defaults to now when provided; omitting it means "permanent" (no time bounds).
   */
  addEdge(sourceId: string, label: EdgeLabel, targetId: string, validFrom?: Date): void {
    const source = this.nodes.get(sourceId);
    if (!source) return;
    source.edges.push({ label, targetId, validFrom, validUntil: undefined });
  }

  /**
   * Close the current active edge and open a new one.
   * The old edge gets validUntil = validFrom of new edge.
   * Used for room transfers, doctor reassignments, etc.
   */
  updateEdge(sourceId: string, label: EdgeLabel, newTargetId: string, validFrom: Date = new Date()): void {
    const source = this.nodes.get(sourceId);
    if (!source) return;

    // Close ALL open edges with this label (including permanent ones with no validFrom).
    // This covers both timestamped edges and addEdge() edges added without timestamps.
    for (const edge of source.edges) {
      if (edge.label === label && edge.validUntil === undefined) {
        edge.validUntil = validFrom;
      }
    }

    source.edges.push({ label, targetId: newTargetId, validFrom, validUntil: undefined });
  }

  /**
   * Get neighboring nodes.
   * - If opts.at is provided: returns edges valid at that point in time.
   * - If opts.at is omitted: returns edges that are currently active
   *   (validUntil is undefined = still open, or validFrom is undefined = permanent).
   */
  getNeighbors(sourceId: string, label?: EdgeLabel, opts?: GetNeighborsOptions): ContextNode[] {
    const source = this.nodes.get(sourceId);
    if (!source) return [];

    const at = opts?.at;
    const result: ContextNode[] = [];

    for (const edge of source.edges) {
      if (label && edge.label !== label) continue;

      const active = at ? this.isEdgeActiveAt(edge, at) : this.isEdgeCurrent(edge);
      if (!active) continue;

      const target = this.nodes.get(edge.targetId);
      if (target) result.push(target);
    }

    return result;
  }

  private isEdgeCurrent(edge: TemporalEdge): boolean {
    // An edge is current only when it hasn't been closed (no validUntil).
    // validFrom is irrelevant for "current" — only historical at-time queries use it.
    return edge.validUntil === undefined;
  }

  private isEdgeActiveAt(edge: TemporalEdge, at: Date): boolean {
    // If the edge started after `at`, it wasn't active yet
    if (edge.validFrom !== undefined && edge.validFrom.getTime() > at.getTime()) return false;
    // If the edge ended at or before `at`, it's no longer active
    if (edge.validUntil !== undefined && edge.validUntil.getTime() <= at.getTime()) return false;
    return true;
  }

  serialize(): string {
    const out: Record<string, unknown> = {};
    for (const [id, node] of this.nodes) {
      out[id] = { type: node.type, data: node.data, edgeCount: node.edges.length };
    }
    return JSON.stringify(out);
  }
}
