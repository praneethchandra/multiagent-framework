import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { ContextManagerConfigSchema } from "../types.js";
import type { ContextManagerConfig, ContextManagerConfigInput, ContextTemplate, ContextFieldMeta } from "../types.js";
import type { RunContext } from "../types.js";
import type { ContextAssembly, ContextType } from "./contextTypes.js";
import type { ContextTree } from "./contextTree.js";
import type { MemoryManager } from "./memoryManager.js";

// Derived temporal fields auto-populated without needing a vars entry.
const TEMPORAL_AUTO: Record<string, () => string> = {
  requestTimestamp: () => new Date().toISOString(),
  currentDate:      () => new Date().toISOString().split("T")[0],
};

// System fields auto-populated from vars or fallback.
const SYSTEM_AUTO: Record<string, string> = {
  modelId: "unknown",
};

// Rough token estimate: 4 chars ≈ 1 token.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export class ContextManager {
  private readonly cfg: ContextManagerConfig;
  private readonly baseDir: string;
  private readonly mm?: MemoryManager;
  private readonly templateCache = new Map<string, ContextTemplate>();

  constructor(cfg: ContextManagerConfigInput, baseDir: string, mm?: MemoryManager) {
    this.cfg = ContextManagerConfigSchema.parse(cfg);
    this.baseDir = baseDir;
    this.mm = mm;
  }

  loadTemplate(role: string): ContextTemplate {
    const cached = this.templateCache.get(role);
    if (cached) return cached;

    const templateDir = path.isAbsolute(this.cfg.templateDir)
      ? this.cfg.templateDir
      : path.resolve(this.baseDir, this.cfg.templateDir);

    const filePath = path.join(templateDir, `${role}.context.yml`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Context template for role "${role}" not found at: ${filePath}`);
    }

    const raw = yaml.load(fs.readFileSync(filePath, "utf8")) as ContextTemplate;
    this.templateCache.set(role, raw);
    return raw;
  }

  async assemble(
    role: string,
    runCtx: RunContext,
    _tree: ContextTree,
    agentId: string,
    tenantId: string,
  ): Promise<ContextAssembly> {
    if (this.mm) this.mm.evictExpired();

    // Derive the entity's own ID (e.g. patientId for "patient" role, doctorId for "doctor").
    // This makes warm-tier keys entity-scoped so event-bus evictions (which know patientId,
    // not agentId) correctly invalidate the right cache entries.
    const userId = runCtx.vars[`${role}Id`] ?? agentId;

    const template = this.loadTemplate(role);
    const sections = new Map<ContextType, string[]>();
    const warnings: string[] = [];

    for (const [fieldName, meta] of Object.entries(template.fields)) {
      const value = this.resolveField(fieldName, meta, runCtx, userId, tenantId);

      if (value === undefined) {
        warnings.push(...this.handleMissingField(fieldName, meta));
        continue;
      }

      // Promote to warm tier (respecting PHI hard-block)
      if (this.mm && meta.promote === "always" && !meta.phi) {
        this.mm.set(
          `${tenantId}:${userId}:${fieldName}`,
          value,
          meta.ttl,
          meta.promote_ttl,
          meta.phi,
          "always",
        );
      } else if (this.mm && meta.promote === "access_count" && !meta.phi) {
        // Only set if not already in warm tier (to avoid resetting access count)
        if (!this.mm.get(`${tenantId}:${userId}:${fieldName}`)) {
          this.mm.set(
            `${tenantId}:${userId}:${fieldName}`,
            value,
            meta.ttl,
            meta.promote_ttl,
            meta.phi,
            "access_count",
          );
        }
      }
      // promote=explicit: never auto-set, only via mm.promote()

      // Apply PHI gate
      const displayValue = meta.phi && !this.cfg.allowPhi ? "[REDACTED-PHI]" : value;

      const ctxType = meta.type as ContextType;
      if (!sections.has(ctxType)) sections.set(ctxType, []);
      sections.get(ctxType)!.push(`${fieldName}: ${displayValue}`);
    }

    // Collapse string arrays into single strings
    const collapsedSections = new Map<ContextType, string>();
    for (const [type, lines] of sections) {
      collapsedSections.set(type, lines.join("\n"));
    }

    const totalTokenEstimate = [...collapsedSections.values()]
      .reduce((sum, s) => sum + estimateTokens(s), 0);

    return { sections: collapsedSections, totalTokenEstimate, warnings };
  }

  buildInjection(assembly: ContextAssembly): string {
    if (assembly.sections.size === 0) return "";

    const parts: string[] = ["=== CONTEXT ==="];
    for (const [type, content] of assembly.sections) {
      if (content.trim().length === 0) continue;
      parts.push(`[${type}]\n${content}`);
    }
    parts.push("=== END CONTEXT ===");
    return parts.join("\n\n");
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private resolveField(
    fieldName: string,
    meta: ContextFieldMeta,
    runCtx: RunContext,
    userId: string,
    tenantId: string,
  ): string | undefined {
    // 1. Warm tier
    if (this.mm) {
      const warm = this.mm.get(`${tenantId}:${userId}:${fieldName}`);
      if (warm !== undefined) return warm;
    }

    // 2. RunContext.vars
    if (runCtx.vars[fieldName] !== undefined) return runCtx.vars[fieldName];

    // 3. Auto-derived: TemporalContext
    if (meta.type === "TemporalContext" && TEMPORAL_AUTO[fieldName]) {
      return TEMPORAL_AUTO[fieldName]();
    }

    // 4. Auto-derived: SystemContext
    if (meta.type === "SystemContext" && fieldName in SYSTEM_AUTO) {
      return runCtx.vars[fieldName] ?? SYSTEM_AUTO[fieldName];
    }

    return undefined;
  }

  private handleMissingField(fieldName: string, meta: ContextFieldMeta): string[] {
    switch (meta.requirement) {
      case "REQUIRED":
        return [`ESCALATE: REQUIRED field "${fieldName}" (${meta.type}) is missing — agent may produce incorrect output`];
      case "GRACEFUL_FALLBACK":
        return [`GRACEFUL_FALLBACK: field "${fieldName}" (${meta.type}) is missing — proceeding with empty value`];
      case "OPTIONAL":
      default:
        return [];
    }
  }
}
