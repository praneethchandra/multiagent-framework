import { describe, it, expect, beforeEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as yaml from "js-yaml";
import { ContextManager } from "../../context/contextManager.js";
import { MemoryManager } from "../../context/memoryManager.js";
import { ContextTree } from "../../context/contextTree.js";
import type { RunContext } from "../../types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(vars: Record<string, string> = {}): RunContext {
  return { vars, goal: "test", tokenUsage: { input: 0, output: 0 } };
}

function makeMgr(overrides = {}) {
  return new MemoryManager({ warmTierMaxEntries: 100, defaultTtlSeconds: 300, accessCountThreshold: 3, ...overrides });
}

/** Write a context template YAML to a temp dir and return the dir path. */
function writeTempTemplate(role: string, fields: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtest-"));
  fs.writeFileSync(
    path.join(dir, `${role}.context.yml`),
    yaml.dump({ role, fields }),
  );
  return dir;
}

// ── basic assembly ────────────────────────────────────────────────────────────

describe("ContextManager.assemble()", () => {
  it("returns a value from RunContext.vars for a non-PHI field", async () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext", ttl: 3600, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const ctx = makeCtx({ doctorId: "dr_smith" });
    const asm = await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    expect(asm.sections.get("UserContext")).toContain("dr_smith");
  });

  it("warm-tier HIT is used instead of vars", async () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext", ttl: 3600, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const mm = makeMgr();
    // userId is derived as vars.doctorId ?? agentId; here vars.doctorId = "dr_cold", so userId="dr_cold"
    mm.set("t1:dr_cold:doctorId", "dr_warm", 3600);
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, mm);
    const ctx = makeCtx({ doctorId: "dr_cold" });
    const asm = await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    expect(asm.sections.get("UserContext")).toContain("dr_warm");
    expect(asm.sections.get("UserContext")).not.toContain("dr_cold");
  });

  it("promotes a field to warm tier on assemble when promote=always", async () => {
    const dir = writeTempTemplate("doctor", {
      drugRules: { type: "DomainContext", ttl: 3600, requirement: "OPTIONAL", phi: false, promote: "always" },
    });
    const mm = makeMgr();
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, mm);
    // No doctorId in vars → userId falls back to agentId = "doctor_agent"
    const ctx = makeCtx({ drugRules: "no opioids" });
    await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    expect(mm.get("t1:doctor_agent:drugRules")).toBe("no opioids");
  });

  // ── requirement rules ─────────────────────────────────────────────────────

  it("REQUIRED field missing → warnings contains ESCALATE, assembly still returns", async () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext", ttl: 3600, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const ctx = makeCtx({}); // no doctorId
    const asm = await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    expect(asm.warnings.some(w => w.includes("ESCALATE") && w.includes("doctorId"))).toBe(true);
  });

  it("OPTIONAL field missing → no warning, empty value used", async () => {
    const dir = writeTempTemplate("doctor", {
      notes: { type: "ConversationContext", ttl: 300, requirement: "OPTIONAL", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const asm = await cm.assemble("doctor", makeCtx(), new ContextTree(), "doctor_agent", "t1");
    expect(asm.warnings).toHaveLength(0);
  });

  it("GRACEFUL_FALLBACK field missing with no stale value → warning, not ESCALATE", async () => {
    const dir = writeTempTemplate("doctor", {
      patientHistory: { type: "RetrievalContext", ttl: 300, requirement: "GRACEFUL_FALLBACK", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const asm = await cm.assemble("doctor", makeCtx(), new ContextTree(), "doctor_agent", "t1");
    expect(asm.warnings.some(w => w.includes("GRACEFUL_FALLBACK") && w.includes("patientHistory"))).toBe(true);
    expect(asm.warnings.some(w => w.includes("ESCALATE"))).toBe(false);
  });

  // ── PHI gate ──────────────────────────────────────────────────────────────

  it("phi:true + allowPhi:false → value redacted to [REDACTED-PHI]", async () => {
    const dir = writeTempTemplate("patient", {
      allergies: { type: "UserContext", ttl: 300, requirement: "OPTIONAL", phi: true, promote: "explicit" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const ctx = makeCtx({ allergies: "penicillin" });
    const asm = await cm.assemble("patient", ctx, new ContextTree(), "patient_agent", "t1");
    const section = asm.sections.get("UserContext") ?? "";
    expect(section).toContain("[REDACTED-PHI]");
    expect(section).not.toContain("penicillin");
  });

  it("phi:true + allowPhi:true → value is included", async () => {
    const dir = writeTempTemplate("patient", {
      allergies: { type: "UserContext", ttl: 300, requirement: "OPTIONAL", phi: true, promote: "explicit" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: true }, dir, makeMgr());
    const ctx = makeCtx({ allergies: "penicillin" });
    const asm = await cm.assemble("patient", ctx, new ContextTree(), "patient_agent", "t1");
    const section = asm.sections.get("UserContext") ?? "";
    expect(section).toContain("penicillin");
  });

  it("phi:true field is never written to warm tier even when promote=always", async () => {
    const dir = writeTempTemplate("patient", {
      patientName: { type: "UserContext", ttl: 300, requirement: "OPTIONAL", phi: true, promote: "always" },
    });
    const mm = makeMgr();
    const cm = new ContextManager({ templateDir: dir, allowPhi: true }, dir, mm);
    const ctx = makeCtx({ patientName: "Alice" });
    await cm.assemble("patient", ctx, new ContextTree(), "patient_agent", "t1");
    // warm tier must be empty for this PHI field
    expect(mm.get("t1:patient_agent:patientName")).toBeUndefined();
  });

  // ── TemporalContext ───────────────────────────────────────────────────────

  it("TemporalContext field requestTimestamp is auto-populated from Date.now()", async () => {
    const dir = writeTempTemplate("doctor", {
      requestTimestamp: { type: "TemporalContext", ttl: 0, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const asm = await cm.assemble("doctor", makeCtx(), new ContextTree(), "doctor_agent", "t1");
    const section = asm.sections.get("TemporalContext") ?? "";
    // Should contain an ISO timestamp or numeric timestamp
    expect(section.length).toBeGreaterThan(0);
    expect(asm.warnings.some(w => w.includes("ESCALATE") && w.includes("requestTimestamp"))).toBe(false);
  });

  // ── SystemContext ─────────────────────────────────────────────────────────

  it("SystemContext field modelId is auto-populated from vars or 'unknown'", async () => {
    const dir = writeTempTemplate("doctor", {
      modelId: { type: "SystemContext", ttl: 0, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const ctx = makeCtx({ modelId: "claude-sonnet-4-6" });
    const asm = await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    const section = asm.sections.get("SystemContext") ?? "";
    expect(section).toContain("claude-sonnet-4-6");
  });

  // ── token budget split ────────────────────────────────────────────────────

  it("buildInjection output contains section headers for non-empty sections", async () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext",   ttl: 300, requirement: "REQUIRED", phi: false, promote: "always" },
      shiftInfo: { type: "TemporalContext", ttl: 300, requirement: "OPTIONAL", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const ctx = makeCtx({ doctorId: "dr_smith", shiftInfo: "morning" });
    const asm = await cm.assemble("doctor", ctx, new ContextTree(), "doctor_agent", "t1");
    const injection = cm.buildInjection(asm);
    expect(injection).toContain("UserContext");
    expect(injection).toContain("TemporalContext");
    expect(injection).toContain("dr_smith");
  });

  it("totalTokenEstimate is > 0 when sections have content", async () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext", ttl: 300, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const asm = await cm.assemble("doctor", makeCtx({ doctorId: "dr_smith" }), new ContextTree(), "doctor_agent", "t1");
    expect(asm.totalTokenEstimate).toBeGreaterThan(0);
  });

  // ── template caching ──────────────────────────────────────────────────────

  it("loadTemplate is cached after first read (same object reference)", () => {
    const dir = writeTempTemplate("doctor", {
      doctorId: { type: "UserContext", ttl: 300, requirement: "REQUIRED", phi: false, promote: "always" },
    });
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    const t1 = cm.loadTemplate("doctor");
    const t2 = cm.loadTemplate("doctor");
    expect(t1).toBe(t2);
  });

  it("throws a clear error if template file does not exist", () => {
    const dir = writeTempTemplate("doctor", {});
    const cm = new ContextManager({ templateDir: dir, allowPhi: false }, dir, makeMgr());
    expect(() => cm.loadTemplate("nonexistent")).toThrow(/template.*nonexistent/i);
  });
});
