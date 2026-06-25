import type { MemoryManagerConfig } from "../types.js";

type PromoteTrigger = "always" | "access_count" | "explicit";

interface WarmEntry {
  value: string;
  expiresAt: number;      // ms epoch; 0 = no expiry
  accessCount: number;
  promoteTtl: number;     // seconds; 0 = no extended TTL
  promoteTrigger: PromoteTrigger;
}

export class MemoryManager {
  private warm = new Map<string, WarmEntry>();
  private readonly cfg: MemoryManagerConfig;

  constructor(cfg: MemoryManagerConfig) {
    this.cfg = cfg;
  }

  /**
   * Retrieve a value.
   * Returns undefined if the key is missing or has expired.
   * Increments accessCount and may trigger access_count promotion.
   */
  get(key: string): string | undefined {
    const entry = this.warm.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
      this.warm.delete(key);
      return undefined;
    }

    entry.accessCount++;

    if (
      entry.promoteTrigger === "access_count" &&
      entry.promoteTtl > 0 &&
      entry.accessCount >= this.cfg.accessCountThreshold
    ) {
      entry.expiresAt = Date.now() + entry.promoteTtl * 1000;
    }

    return entry.value;
  }

  /**
   * Store a value.
   * isPhi=true: silently skips the write (PHI hard-block).
   * promoteTrigger: governs auto-promotion behaviour on subsequent gets.
   */
  set(
    key: string,
    value: string,
    ttlSeconds: number,
    promoteTtl = 0,
    isPhi = false,
    promoteTrigger: PromoteTrigger = "always",
  ): void {
    if (isPhi) return; // hard-block: PHI never enters warm tier

    const expiresAt = ttlSeconds === 0 ? 0 : Date.now() + ttlSeconds * 1000;
    this.warm.set(key, { value, expiresAt, accessCount: 0, promoteTtl, promoteTrigger });
    this.enforceMaxEntries();
  }

  /** Manually extend the entry's TTL to its promoteTtl. */
  promote(key: string): void {
    const entry = this.warm.get(key);
    if (!entry || entry.promoteTtl === 0) return;
    entry.expiresAt = Date.now() + entry.promoteTtl * 1000;
  }

  evict(key: string): void {
    this.warm.delete(key);
  }

  /**
   * Evict all entries whose keys start with "tenantId:entityId:" prefix.
   * Used by discharge / full-patient-eviction events.
   */
  evictByPrefix(prefix: string): void {
    for (const key of this.warm.keys()) {
      if (key.startsWith(prefix)) this.warm.delete(key);
    }
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.warm) {
      if (entry.expiresAt !== 0 && now > entry.expiresAt) {
        this.warm.delete(key);
      }
    }
  }

  enforceMaxEntries(): void {
    if (this.warm.size <= this.cfg.warmTierMaxEntries) return;
    // Map preserves insertion order; first key is oldest
    const oldest = this.warm.keys().next().value;
    if (oldest !== undefined) this.warm.delete(oldest);
  }

  size(): number {
    return this.warm.size;
  }
}
