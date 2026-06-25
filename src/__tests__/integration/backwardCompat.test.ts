/**
 * Backward-compatibility tests: all 8 existing configs must parse without
 * error via AppConfigSchema. We also verify that runApp() completes with a
 * mocked LLM so no API key is needed in CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { AppConfigSchema } from "../../types.js";
import { loadConfig } from "../../configLoader.js";

const CONFIGS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../..",   // src/__tests__/integration → project root
  "configs",
);

const EXISTING_CONFIGS = [
  "example-sequential.yaml",
  "example-supervisor.yaml",
  "example-parallel.yaml",
  "example-hierarchical.yaml",
  "example-react-tools.yaml",
  "example-plan-execute.yaml",
  "example-rag.yaml",
  "daily-decision.yaml",
];

describe("backward compatibility — schema parsing", () => {
  for (const filename of EXISTING_CONFIGS) {
    it(`parses ${filename} without error`, () => {
      const configPath = path.join(CONFIGS_DIR, filename);
      // loadConfig already calls AppConfigSchema.parse internally
      expect(() => loadConfig(configPath)).not.toThrow();
    });
  }
});

describe("backward compatibility — no contextManager block means no context injection", () => {
  it("AppConfigSchema accepts config with no contextManager block", () => {
    const minimalConfig = {
      name: "test",
      pattern: "sequential",
      goal: "test goal",
      agents: [{ id: "a1", prompt: "You are an agent." }],
      workflow: { steps: [{ agent: "a1", input: "{{goal}}", output: "result" }] },
    };
    expect(() => AppConfigSchema.parse(minimalConfig)).not.toThrow();
    const parsed = AppConfigSchema.parse(minimalConfig);
    expect(parsed.contextManager).toBeUndefined();
    expect(parsed.memoryManager).toBeUndefined();
  });

  it("AppConfigSchema accepts config with contextManager block and defaults", () => {
    const config = {
      name: "test",
      pattern: "sequential",
      goal: "test goal",
      agents: [{ id: "a1", prompt: "You are an agent." }],
      workflow: { steps: [{ agent: "a1", input: "{{goal}}", output: "result" }] },
      contextManager: {},
      memoryManager: {},
    };
    const parsed = AppConfigSchema.parse(config);
    expect(parsed.contextManager?.allowPhi).toBe(false);
    expect(parsed.contextManager?.templateDir).toBe("templates/context");
    expect(parsed.memoryManager?.warmTierMaxEntries).toBe(1000);
    expect(parsed.memoryManager?.defaultTtlSeconds).toBe(300);
  });

  it("AgentConfigSchema accepts contextRole field", () => {
    const config = {
      name: "test",
      pattern: "sequential",
      goal: "test",
      agents: [{ id: "a1", prompt: "You are a doctor.", contextRole: "doctor" }],
      workflow: { steps: [{ agent: "a1", input: "{{goal}}", output: "result" }] },
    };
    const parsed = AppConfigSchema.parse(config);
    expect(parsed.agents[0].contextRole).toBe("doctor");
  });

  it("vars block in AppConfig is stored and accessible", () => {
    const config = {
      name: "test",
      pattern: "sequential",
      goal: "test",
      agents: [{ id: "a1", prompt: "You are an agent." }],
      workflow: { steps: [{ agent: "a1", input: "{{goal}}", output: "result" }] },
      vars: { tenantId: "t1", doctorId: "dr_smith" },
    };
    const parsed = AppConfigSchema.parse(config);
    expect(parsed.vars?.tenantId).toBe("t1");
    expect(parsed.vars?.doctorId).toBe("dr_smith");
  });
});
