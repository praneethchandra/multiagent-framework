import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { AppConfig, AppConfigSchema } from "./types.js";

export function loadConfig(configPath: string): { config: AppConfig; baseDir: string } {
  const absPath = path.resolve(configPath);
  const raw = fs.readFileSync(absPath, "utf-8");
  const parsed = yaml.load(raw);
  const config = AppConfigSchema.parse(parsed);
  const baseDir = path.dirname(absPath);
  validatePatternConfig(config);
  validateAgentConfigs(config);
  validateToolConfigs(config);
  return { config, baseDir };
}

function validateAgentConfigs(config: AppConfig) {
  const toolIds = new Set(config.tools.map((t) => t.id));
  const storeIds = new Set(config.retrievalStores.map((s) => s.id));
  for (const agent of config.agents) {
    const v = agent.validate;
    if (v) {
      if (v.type === "rule" && !v.rule) {
        throw new Error(`agent "${agent.id}": validate.type is "rule" but validate.rule is missing`);
      }
      if (v.type === "llm" && !v.criteria) {
        throw new Error(`agent "${agent.id}": validate.type is "llm" but validate.criteria is missing`);
      }
    }
    for (const toolId of agent.tools) {
      if (!toolIds.has(toolId)) {
        throw new Error(`agent "${agent.id}" references unknown tool "${toolId}" -- not found in top-level "tools[]"`);
      }
    }
    if (agent.retrieval && !storeIds.has(agent.retrieval.store)) {
      throw new Error(
        `agent "${agent.id}" references unknown retrieval store "${agent.retrieval.store}" -- not found in top-level "retrievalStores[]"`,
      );
    }
  }
}

function validateToolConfigs(config: AppConfig) {
  for (const tool of config.tools) {
    if (tool.type === "http_get" && (!tool.allowedDomains || tool.allowedDomains.length === 0)) {
      throw new Error(`tool "${tool.id}" (http_get) must set "allowedDomains" -- an unrestricted http_get tool is a security hole`);
    }
    if (tool.type === "file_read" && !tool.baseDir) {
      throw new Error(`tool "${tool.id}" (file_read) must set "baseDir" -- an unrestricted file_read tool is a security hole`);
    }
  }
}

function validatePatternConfig(config: AppConfig) {
  switch (config.pattern) {
    case "sequential":
      if (!config.workflow) {
        throw new Error('pattern "sequential" requires a top-level "workflow" block');
      }
      break;
    case "supervisor":
      if (!config.supervisorConfig) {
        throw new Error('pattern "supervisor" requires a top-level "supervisorConfig" block');
      }
      break;
    case "parallel":
      if (!config.parallel) {
        throw new Error('pattern "parallel" requires a top-level "parallel" block');
      }
      break;
    case "hierarchical":
      if (!config.hierarchical) {
        throw new Error('pattern "hierarchical" requires a top-level "hierarchical" block');
      }
      break;
    case "plan_execute":
      if (!config.planExecute) {
        throw new Error('pattern "plan_execute" requires a top-level "planExecute" block');
      }
      break;
  }
}

export function resolvePrompt(baseDir: string, agent: { prompt?: string; promptFile?: string; id: string }): string {
  if (agent.prompt) return agent.prompt;
  if (agent.promptFile) {
    const p = path.resolve(baseDir, agent.promptFile);
    if (!fs.existsSync(p)) {
      throw new Error(`promptFile not found for agent "${agent.id}": ${p}`);
    }
    return fs.readFileSync(p, "utf-8");
  }
  throw new Error(`agent "${agent.id}" must define either "prompt" or "promptFile"`);
}
