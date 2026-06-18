import { AgentConfig, LlmConfig } from "./types.js";
import { resolvePrompt } from "./configLoader.js";
import { callModel } from "./llmClient.js";

export class Agent {
  readonly id: string;
  readonly role: string;
  readonly systemPrompt: string;
  private readonly llm: LlmConfig;
  private readonly modelOverride?: string;

  constructor(config: AgentConfig, llm: LlmConfig, baseDir: string) {
    this.id = config.id;
    this.role = config.role ?? config.id;
    this.systemPrompt = resolvePrompt(baseDir, config);
    this.llm = llm;
    this.modelOverride = config.model;
  }

  async run(message: string): Promise<string> {
    return callModel(this.llm, this.systemPrompt, message, this.modelOverride);
  }
}

export function buildAgentMap(
  agentConfigs: AgentConfig[],
  llm: LlmConfig,
  baseDir: string,
): Map<string, Agent> {
  const map = new Map<string, Agent>();
  for (const cfg of agentConfigs) {
    map.set(cfg.id, new Agent(cfg, llm, baseDir));
  }
  return map;
}
