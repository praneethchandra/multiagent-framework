import Anthropic from "@anthropic-ai/sdk";
import { LlmConfig } from "./types.js";

const clientCache = new Map<string, Anthropic>();

function getClient(apiKeyEnv: string): Anthropic {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key. Set the "${apiKeyEnv}" environment variable.`);
  }
  let client = clientCache.get(apiKeyEnv);
  if (!client) {
    client = new Anthropic({ apiKey });
    clientCache.set(apiKeyEnv, client);
  }
  return client;
}

export interface ModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callModel(
  llm: LlmConfig,
  systemPrompt: string,
  userMessage: string,
  modelOverride?: string,
): Promise<ModelResult> {
  const client = getClient(llm.apiKeyEnv);
  const response = await client.messages.create({
    model: modelOverride ?? llm.model,
    max_tokens: llm.maxTokens,
    temperature: llm.temperature,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
