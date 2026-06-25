import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryManager } from "../../context/memoryManager.js";

function makeMgr(overrides?: { warmTierMaxEntries?: number; defaultTtlSeconds?: number; accessCountThreshold?: number }) {
  return new MemoryManager({
    warmTierMaxEntries: overrides?.warmTierMaxEntries ?? 100,
    defaultTtlSeconds: overrides?.defaultTtlSeconds ?? 300,
    accessCountThreshold: overrides?.accessCountThreshold ?? 3,
  });
}

describe("MemoryManager", () => {
  let mgr: MemoryManager;

  beforeEach(() => {
    mgr = makeMgr();
    vi.useRealTimers();
  });

  // ── basic get / set ──────────────────────────────────────────────────────

  it("returns a value that was set", () => {
    mgr.set("t1:u1:field", "hello", 300);
    expect(mgr.get("t1:u1:field")).toBe("hello");
  });

  it("returns undefined for unknown key", () => {
    expect(mgr.get("t1:u1:missing")).toBeUndefined();
  });

  it("set overwrites existing entry", () => {
    mgr.set("t1:u1:field", "v1", 300);
    mgr.set("t1:u1:field", "v2", 300);
    expect(mgr.get("t1:u1:field")).toBe("v2");
  });

  // ── TTL expiry ───────────────────────────────────────────────────────────

  it("get returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:field", "ephemeral", 1); // 1 second TTL
    vi.advanceTimersByTime(1001);
    expect(mgr.get("t1:u1:field")).toBeUndefined();
  });

  it("get still returns value just before TTL expires", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:field", "still-valid", 5);
    vi.advanceTimersByTime(4999);
    expect(mgr.get("t1:u1:field")).toBe("still-valid");
  });

  it("ttl=0 means no expiry", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:permanent", "forever", 0);
    vi.advanceTimersByTime(999_999_999);
    expect(mgr.get("t1:u1:permanent")).toBe("forever");
  });

  // ── PHI block ────────────────────────────────────────────────────────────

  it("set with isPhi=true never writes to warm tier", () => {
    mgr.set("t1:u1:patientName", "Alice", 300, undefined, true);
    expect(mgr.get("t1:u1:patientName")).toBeUndefined();
  });

  it("set with isPhi=false writes normally", () => {
    mgr.set("t1:u1:doctorId", "dr_smith", 300, undefined, false);
    expect(mgr.get("t1:u1:doctorId")).toBe("dr_smith");
  });

  // ── evictExpired ─────────────────────────────────────────────────────────

  it("evictExpired removes only expired entries", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:short", "bye", 1);
    mgr.set("t1:u1:long",  "hi",  300);
    vi.advanceTimersByTime(1001);
    mgr.evictExpired();
    expect(mgr.get("t1:u1:short")).toBeUndefined();
    expect(mgr.get("t1:u1:long")).toBe("hi");
  });

  it("evictExpired on empty manager does not throw", () => {
    expect(() => mgr.evictExpired()).not.toThrow();
  });

  // ── explicit evict ────────────────────────────────────────────────────────

  it("evict removes a specific key", () => {
    mgr.set("t1:u1:field", "v", 300);
    mgr.evict("t1:u1:field");
    expect(mgr.get("t1:u1:field")).toBeUndefined();
  });

  it("evict on unknown key is a no-op", () => {
    expect(() => mgr.evict("t1:u1:ghost")).not.toThrow();
  });

  // ── LRU enforceMaxEntries ─────────────────────────────────────────────────

  it("enforceMaxEntries evicts oldest entry when over limit", () => {
    const small = makeMgr({ warmTierMaxEntries: 3 });
    small.set("t1:u1:a", "A", 300);
    small.set("t1:u1:b", "B", 300);
    small.set("t1:u1:c", "C", 300);
    small.set("t1:u1:d", "D", 300); // triggers eviction of oldest (a)
    expect(small.get("t1:u1:a")).toBeUndefined();
    expect(small.get("t1:u1:b")).toBe("B");
    expect(small.get("t1:u1:d")).toBe("D");
  });

  it("size() reflects current entry count", () => {
    mgr.set("t1:u1:x", "1", 300);
    mgr.set("t1:u1:y", "2", 300);
    expect(mgr.size()).toBe(2);
    mgr.evict("t1:u1:x");
    expect(mgr.size()).toBe(1);
  });

  // ── promotion triggers ─────────────────────────────────────────────────────

  it("promote() extends TTL to promoteTtl for a live entry", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:field", "v", 1, 3600); // 1s TTL, 3600s promoteTtl
    vi.advanceTimersByTime(800); // still alive
    mgr.promote("t1:u1:field");
    vi.advanceTimersByTime(1500); // would have expired without promotion
    expect(mgr.get("t1:u1:field")).toBe("v");
  });

  it("promote() on unknown key is a no-op", () => {
    expect(() => mgr.promote("t1:u1:ghost")).not.toThrow();
  });

  it("access_count: auto-promotes after reaching threshold", () => {
    vi.useFakeTimers();
    // short ttl but long promoteTtl
    mgr.set("t1:u1:field", "v", 2, 3600, false, "access_count");
    // read 3 times (threshold default=3) → should promote on 3rd get
    mgr.get("t1:u1:field");
    mgr.get("t1:u1:field");
    mgr.get("t1:u1:field"); // 3rd access triggers promotion
    vi.advanceTimersByTime(2500); // past original TTL
    expect(mgr.get("t1:u1:field")).toBe("v"); // promoted TTL saves it
  });

  it("access_count: does NOT promote before reaching threshold", () => {
    vi.useFakeTimers();
    const m = makeMgr({ accessCountThreshold: 5 });
    m.set("t1:u1:field", "v", 1, 3600, false, "access_count");
    m.get("t1:u1:field"); // only 1 access
    vi.advanceTimersByTime(1100);
    expect(m.get("t1:u1:field")).toBeUndefined(); // not promoted
  });

  it("explicit trigger: does NOT auto-promote on get", () => {
    vi.useFakeTimers();
    mgr.set("t1:u1:field", "v", 1, 3600, false, "explicit");
    mgr.get("t1:u1:field");
    mgr.get("t1:u1:field");
    mgr.get("t1:u1:field");
    vi.advanceTimersByTime(1100);
    expect(mgr.get("t1:u1:field")).toBeUndefined(); // not promoted
  });

  it("tenantId isolation: same field different tenant returns correct values", () => {
    mgr.set("t1:u1:field", "tenant1-value", 300);
    mgr.set("t2:u1:field", "tenant2-value", 300);
    expect(mgr.get("t1:u1:field")).toBe("tenant1-value");
    expect(mgr.get("t2:u1:field")).toBe("tenant2-value");
  });
});
