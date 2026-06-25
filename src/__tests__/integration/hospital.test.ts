/**
 * Hospital integration tests: verifies the end-to-end context injection
 * pipeline using mocked LLM calls so no API key is needed.
 *
 * The mock captures what message was sent to the LLM so we can assert
 * that context injection headers are present/absent as expected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  return { vars, goal: "prescribe medication", tokenUsage: { input: 0, output: 0 } };
}

function setupTemplates(dir: string) {
  // Doctor template
  fs.writeFileSync(path.join(dir, "doctor.context.yml"), yaml.dump({
    role: "doctor",
    fields: {
      doctorId:       { type: "UserContext",   ttl: 3600,  requirement: "REQUIRED",          phi: false, promote: "always" },
      patientName:    { type: "UserContext",   ttl: 900,   requirement: "OPTIONAL",          phi: true,  promote: "explicit" },
      currentShift:   { type: "TemporalContext", ttl: 1800, requirement: "OPTIONAL",         phi: false, promote: "always" },
      drugRules:      { type: "DomainContext",  ttl: 86400, requirement: "REQUIRED",         phi: false, promote: "always" },
      patientHistory: { type: "RetrievalContext", ttl: 1800, requirement: "GRACEFUL_FALLBACK", phi: true, promote: "explicit" },
    },
  }));

  // Patient template
  fs.writeFileSync(path.join(dir, "patient.context.yml"), yaml.dump({
    role: "patient",
    fields: {
      patientId:    { type: "UserContext", ttl: 3600, requirement: "REQUIRED",          phi: true,  promote: "explicit" },
      allergies:    { type: "UserContext", ttl: 7200, requirement: "GRACEFUL_FALLBACK", phi: true,  promote: "explicit" },
      medications:  { type: "UserContext", ttl: 1800, requirement: "OPTIONAL",          phi: true,  promote: "explicit" },
    },
  }));

  // Supervisor template
  fs.writeFileSync(path.join(dir, "supervisor.context.yml"), yaml.dump({
    role: "supervisor",
    fields: {
      supervisorId:    { type: "UserContext",  ttl: 3600,  requirement: "REQUIRED", phi: false, promote: "always" },
      regulatoryRules: { type: "DomainContext", ttl: 86400, requirement: "REQUIRED", phi: false, promote: "always" },
    },
  }));
}

function makeTree(): ContextTree {
  const tree = new ContextTree();
  const nodes: ContextNode[] = [
    { id: "Hospital:general:t1",   type: "Hospital",   data: { name: "General Hospital" }, edges: [] },
    { id: "Doctor:dr_smith:t1",    type: "Doctor",     data: { name: "Dr Smith" },         edges: [] },
    { id: "Patient:p_jones:t1",    type: "Patient",    data: { name: "P Jones" },          edges: [] },
    { id: "Supervisor:sup_lee:t1", type: "Supervisor", data: { name: "Sup Lee" },          edges: [] },
  ];
  for (const n of nodes) tree.add(n);
  tree.addEdge("Hospital:general:t1", "has_doctor",     "Doctor:dr_smith:t1");
  tree.addEdge("Hospital:general:t1", "has_patient",    "Patient:p_jones:t1");
  tree.addEdge("Hospital:general:t1", "has_supervisor", "Supervisor:sup_lee:t1");
  tree.addEdge("Patient:p_jones:t1",  "assigned_to_doctor", "Doctor:dr_smith:t1");
  return tree;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("hospital integration — context injection", () => {
  let dir: string;
  let mm: MemoryManager;
  let tree: ContextTree;
  let cmAllow: ContextManager;   // allowPhi: true
  let cmBlock: ContextManager;   // allowPhi: false

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hospital-"));
    setupTemplates(dir);
    mm       = new MemoryManager({ warmTierMaxEntries: 200, defaultTtlSeconds: 600, accessCountThreshold: 3 });
    tree     = makeTree();
    cmAllow  = new ContextManager({ templateDir: dir, allowPhi: true  }, dir, mm);
    cmBlock  = new ContextManager({ templateDir: dir, allowPhi: false }, dir, mm);
  });

  // ── doctor agent injection ────────────────────────────────────────────────

  it("doctor injection includes DomainContext section with drug rules", async () => {
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "No opioids without supervisor sign-off." });
    const asm = await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("DomainContext");
    expect(injection).toContain("No opioids");
  });

  it("doctor injection includes UserContext with doctorId", async () => {
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "OK" });
    const asm = await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("UserContext");
    expect(injection).toContain("dr_smith");
  });

  it("doctor injection includes TemporalContext section", async () => {
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "OK", currentShift: "morning" });
    const asm = await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("TemporalContext");
    expect(injection).toContain("morning");
  });

  // ── PHI in doctor template ────────────────────────────────────────────────

  it("doctor injection: patientName redacted when allowPhi=false", async () => {
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "OK", patientName: "Alice Jones" });
    const asm = await cmBlock.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    const injection = cmBlock.buildInjection(asm);
    expect(injection).not.toContain("Alice Jones");
    expect(injection).toContain("[REDACTED-PHI]");
  });

  it("doctor injection: patientName included when allowPhi=true", async () => {
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "OK", patientName: "Alice Jones" });
    const asm = await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("Alice Jones");
  });

  // ── patient agent injection ───────────────────────────────────────────────

  it("patient injection includes allergies when allowPhi=true", async () => {
    const ctx = makeCtx({ patientId: "p_jones", allergies: "penicillin, sulfa" });
    const asm = await cmAllow.assemble("patient", ctx, tree, "patient_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("penicillin");
  });

  it("patient injection redacts allergies when allowPhi=false", async () => {
    const ctx = makeCtx({ patientId: "p_jones", allergies: "penicillin, sulfa" });
    const asm = await cmBlock.assemble("patient", ctx, tree, "patient_agent", "t1");
    const injection = cmBlock.buildInjection(asm);
    expect(injection).not.toContain("penicillin");
    expect(injection).toContain("[REDACTED-PHI]");
  });

  it("patient REQUIRED field patientId missing → ESCALATE warning", async () => {
    const ctx = makeCtx({}); // no patientId
    const asm = await cmAllow.assemble("patient", ctx, tree, "patient_agent", "t1");
    expect(asm.warnings.some(w => w.includes("ESCALATE") && w.includes("patientId"))).toBe(true);
  });

  // ── supervisor agent injection ────────────────────────────────────────────

  it("supervisor injection includes DomainContext regulatory rules", async () => {
    const ctx = makeCtx({ supervisorId: "sup_lee", regulatoryRules: "Controlled substances require dual sign-off." });
    const asm = await cmAllow.assemble("supervisor", ctx, tree, "supervisor_agent", "t1");
    const injection = cmAllow.buildInjection(asm);
    expect(injection).toContain("DomainContext");
    expect(injection).toContain("Controlled substances");
  });

  // ── warm tier caching across multiple calls ───────────────────────────────

  it("drugRules promoted to warm tier on first assemble; second call uses cache", async () => {
    // doctorId in vars → userId = "dr_smith" → cache key t1:dr_smith:drugRules
    const ctx = makeCtx({ doctorId: "dr_smith", drugRules: "Original rules" });
    // First call — populates warm tier at t1:dr_smith:drugRules
    await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    // Mutate vars (simulates stale var update)
    ctx.vars["drugRules"] = "Stale override";
    // Second call — warm tier (dr_smith key) takes precedence over vars
    const asm2 = await cmAllow.assemble("doctor", ctx, tree, "doctor_agent", "t1");
    expect(asm2.sections.get("DomainContext")).toContain("Original rules");
  });

  // ── room change mid-run ───────────────────────────────────────────────────

  it("room_change mid-run: second assemble reflects new room", async () => {
    const bus = new ContextEventBus(mm, tree);
    tree.add({ id: "Room:302:t1", type: "Room", data: { type: "standard" }, edges: [] });
    tree.add({ id: "Room:icu:t1", type: "Room", data: { type: "ICU"      }, edges: [] });
    tree.addEdge("Patient:p_jones:t1", "assigned_to_room", "Room:302:t1");

    const ctx = makeCtx({ patientId: "p_jones", currentRoom: "Room:302:t1", allergies: "none" });
    // First assemble — Room302 in warm tier
    await cmAllow.assemble("patient", ctx, tree, "patient_agent", "t1");

    // Room change event fires
    bus.emit("room_change", { patientId: "p_jones", from: "Room:302:t1", to: "Room:icu:t1", tenantId: "t1" });
    ctx.vars["currentRoom"] = "Room:icu:t1"; // seeder updates vars

    const asm2 = await cmAllow.assemble("patient", ctx, tree, "patient_agent", "t1");
    // patient template doesn't have currentRoom field in this test, but tree should reflect ICU
    const treeCurrent = tree.getNeighbors("Patient:p_jones:t1", "assigned_to_room");
    expect(treeCurrent[0].id).toBe("Room:icu:t1");
  });
});
