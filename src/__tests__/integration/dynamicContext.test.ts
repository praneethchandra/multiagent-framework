/**
 * Dynamic context update tests: verifies that room_change / transfer events
 * correctly invalidate the warm tier and update the context tree so that
 * the next assemble() call reflects the new state.
 *
 * No LLM calls — pure ContextManager + MemoryManager + ContextEventBus.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as yaml from "js-yaml";
import { ContextManager } from "../../context/contextManager.js";
import { MemoryManager } from "../../context/memoryManager.js";
import { ContextTree } from "../../context/contextTree.js";
import { ContextEventBus } from "../../context/contextEventBus.js";
import type { RunContext } from "../../types.js";
import type { ContextNode } from "../../context/contextTypes.js";

function makeCtx(vars: Record<string, string> = {}): RunContext {
  return { vars, goal: "test", tokenUsage: { input: 0, output: 0 } };
}

function writeTempTemplate(dir: string, role: string, fields: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${role}.context.yml`), yaml.dump({ role, fields }));
}

function makeNode(id: string, type: ContextNode["type"], data = {}): ContextNode {
  return { id, type, data, edges: [] };
}

describe("dynamic context updates", () => {
  let dir: string;
  let mm: MemoryManager;
  let tree: ContextTree;
  let bus: ContextEventBus;
  let cm: ContextManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dynctx-"));
    writeTempTemplate(dir, "patient", {
      currentRoom:   { type: "UserContext", ttl: 300,  requirement: "OPTIONAL",          phi: false, promote: "always" },
      currentUnit:   { type: "UserContext", ttl: 300,  requirement: "OPTIONAL",          phi: false, promote: "always" },
      allergies:     { type: "UserContext", ttl: 7200, requirement: "GRACEFUL_FALLBACK", phi: true,  promote: "explicit" },
    });
    mm   = new MemoryManager({ warmTierMaxEntries: 100, defaultTtlSeconds: 300, accessCountThreshold: 3 });
    tree = new ContextTree();
    bus  = new ContextEventBus(mm, tree);
    cm   = new ContextManager({ templateDir: dir, allowPhi: true }, dir, mm);

    // Seed tree
    tree.add(makeNode("Patient:p_jones:t1", "Patient", { patientId: "p_jones" }));
    tree.add(makeNode("Room:302:t1",       "Room",    { type: "standard", floor: 3 }));
    tree.add(makeNode("Room:icu:t1",       "Room",    { type: "ICU",      floor: 2 }));
    tree.add(makeNode("Room:ot:t1",        "Room",    { type: "therapy",  floor: 1 }));
    tree.addEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1");
  });

  it("initial assemble returns Room:302 as currentRoom", async () => {
    // patientId in vars → userId = "p_jones" → cache key t1:p_jones:currentRoom
    const ctx = makeCtx({ patientId: "p_jones", currentRoom: "Room:302:t1" });
    const asm = await cm.assemble("patient", ctx, tree, "patient_agent", "t1");
    expect(asm.sections.get("UserContext")).toContain("Room:302:t1");
  });

  it("after room_change event, assemble returns new room (ICU)", async () => {
    // Seed warm tier with old room using entity-scoped key (t1:p_jones:currentRoom)
    mm.set("t1:p_jones:currentRoom", "Room:302:t1", 300);

    // Fire event — evicts t1:p_jones:currentRoom from warm tier
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });

    // vars now reflect new room (simulates seeder update)
    const ctx = makeCtx({ patientId: "p_jones", currentRoom: "Room:icu:t1" });
    const asm = await cm.assemble("patient", ctx, tree, "patient_agent", "t1");
    expect(asm.sections.get("UserContext")).toContain("Room:icu:t1");
    expect(asm.sections.get("UserContext")).not.toContain("Room:302:t1");
  });

  it("context tree reflects new room after room_change event", () => {
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    const neighbors = tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room");
    expect(neighbors[0].id).toBe("Room:icu:t1");
  });

  it("full patient journey: Room302 → ICU → OT all reflected in tree history", () => {
    const t0 = new Date("2025-01-10T08:00:00Z");
    const t1 = new Date("2025-01-12T08:00:00Z");
    const t2 = new Date("2025-01-15T08:00:00Z");

    // Use updateEdge to close the permanent edge from beforeEach and start the timestamped sequence
    tree.updateEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1", t0);
    tree.updateEdge("Patient:p_jones:t1", "assigned_to_room", "Room:icu:t1", t1);
    tree.updateEdge("Patient:p_jones:t1", "assigned_to_room", "Room:ot:t1", t2);

    // Current state
    expect(tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room")[0].id)
      .toBe("Room:ot:t1");

    // Historical: during ICU stay (Jan 13)
    expect(tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room", { at: new Date("2025-01-13") })[0].id)
      .toBe("Room:icu:t1");

    // Historical: during Room302 stay (Jan 11)
    expect(tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room", { at: new Date("2025-01-11") })[0].id)
      .toBe("Room:302:t1");
  });

  it("discharge event evicts all patient warm-tier entries for that patient", () => {
    mm.set("t1:p_jones:currentRoom",   "Room:302:t1", 300);
    mm.set("t1:p_jones:currentUnit",   "ward-3",      300);
    mm.set("t1:other:currentRoom",     "Room:201:t1", 300);

    bus.emit("discharge", { patientId: "p_jones", tenantId: "t1" });

    expect(mm.get("t1:p_jones:currentRoom")).toBeUndefined();
    expect(mm.get("t1:p_jones:currentUnit")).toBeUndefined();
    expect(mm.get("t1:other:currentRoom")).toBe("Room:201:t1");
  });

  it("warm-tier stale data is NOT served after eviction by event", async () => {
    // Put stale room in warm tier with entity-scoped key
    mm.set("t1:p_jones:currentRoom", "Room:302:t1", 3600); // long TTL
    // Event fires — evicts t1:p_jones:currentRoom
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    // vars have new value; patientId in vars → userId = "p_jones"
    const ctx = makeCtx({ patientId: "p_jones", currentRoom: "Room:icu:t1" });
    const asm = await cm.assemble("patient", ctx, tree, "patient_agent", "t1");
    expect(asm.sections.get("UserContext")).not.toContain("Room:302:t1");
  });
});
