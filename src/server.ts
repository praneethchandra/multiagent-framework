#!/usr/bin/env node
/**
 * HTTP test server wrapping runApp — used exclusively by the Postman
 * regression suite and local development testing. Not intended for production.
 *
 * Endpoints:
 *   GET  /health          — liveness probe
 *   POST /validate        — parse + schema-validate a config, no LLM calls
 *   POST /run             — run an inline config object (requires API key)
 *   POST /run/file        — run a named config file from the configs/ directory
 */
import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { AppConfigSchema } from "./types.js";
import { loadConfig } from "./configLoader.js";
import { runApp } from "./orchestrator.js";

dotenv.config();

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const configsDir = path.resolve(__dirname, "..", "configs");

const app  = express();
const PORT = parseInt(process.env.TEST_SERVER_PORT ?? "3737", 10);

app.use(express.json({ limit: "2mb" }));

// ── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status:  "ok",
    version: "0.1.0",
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

// ── POST /validate ───────────────────────────────────────────────────────────
// Parses and Zod-validates the supplied config object. No LLM calls made.
app.post("/validate", (req: Request, res: Response) => {
  try {
    const result = AppConfigSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        valid:  false,
        errors: result.error.issues.map(i => ({
          path:    i.path.join("."),
          message: i.message,
        })),
      });
    }
    const cfg = result.data;
    return res.json({
      valid:       true,
      name:        cfg.name,
      pattern:     cfg.pattern,
      agentCount:  cfg.agents.length,
      toolCount:   cfg.tools.length,
      hasContext:  Boolean(cfg.contextManager),
      hasMemory:   Boolean(cfg.memoryManager),
      hasGraph:    Boolean(cfg.graphStore),
    });
  } catch (err) {
    return res.status(500).json({ valid: false, error: (err as Error).message });
  }
});

// ── POST /run ────────────────────────────────────────────────────────────────
// Runs an inline config object. Requires ANTHROPIC_API_KEY in environment.
app.post("/run", async (req: Request, res: Response) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not set — LLM calls unavailable" });
  }
  try {
    const result = AppConfigSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error:  "Invalid config",
        issues: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const logs: string[] = [];
    const ctx = await runApp(result.data, configsDir, (msg) => logs.push(msg));
    return res.json({
      success:    true,
      vars:       ctx.vars,
      tokenUsage: ctx.tokenUsage,
      logs,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── POST /run/file ───────────────────────────────────────────────────────────
// Loads a config file from configs/<name>.yaml and runs it.
app.post("/run/file", async (req: Request, res: Response) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not set — LLM calls unavailable" });
  }
  const { name, vars } = req.body as { name?: string; vars?: Record<string, string> };
  if (!name) {
    return res.status(400).json({ error: "body.name is required" });
  }
  // Path traversal guard: name must be a simple filename with no slashes
  if (/[/\\.]/.test(name)) {
    return res.status(400).json({ error: "name must be a plain filename (no path separators or dots)" });
  }
  try {
    const filePath = path.join(configsDir, `${name}.yaml`);
    const { config, baseDir } = loadConfig(filePath);
    // Merge any extra vars from the request body into config.vars
    if (vars) {
      config.vars = { ...(config.vars ?? {}), ...vars };
    }
    const logs: string[] = [];
    const ctx = await runApp(config, baseDir, (msg) => logs.push(msg));
    return res.json({
      success:    true,
      vars:       ctx.vars,
      tokenUsage: ctx.tokenUsage,
      logs,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[test-server] listening on http://localhost:${PORT}`);
  console.log(`[test-server] API key: ${process.env.ANTHROPIC_API_KEY ? "present" : "NOT SET (LLM tests disabled)"}`);
});

export { app };
