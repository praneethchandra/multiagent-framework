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

export interface ToolUseRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelResult {
  text: string;
  toolUses: ToolUseRequest[];
  contentBlocks: Anthropic.ContentBlock[]; // raw blocks, needed to echo the assistant turn back verbatim
  inputTokens: number;
  outputTokens: number;
}

// Multi-turn call with optional tool definitions -- the primitive the ReAct
// loop (Agent.runReAct) is built on. Plain single-shot callers use
// callSingle() below instead of constructing a one-element messages array
// by hand everywhere.
export async function callModel(
  llm: LlmConfig,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  modelOverride?: string,
  tools?: Anthropic.Tool[],
): Promise<ModelResult> {
  const client = getClient(llm.apiKeyEnv);
  const response = await client.messages.create({
    model: modelOverride ?? llm.model,
    max_tokens: llm.maxTokens,
    temperature: llm.temperature,
    system: systemPrompt,
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const toolUses = response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input as Record<string, unknown> }));
  return {
    text,
    toolUses,
    contentBlocks: response.content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export async function callSingle(
  llm: LlmConfig,
  systemPrompt: string,
  userMessage: string,
  modelOverride?: string,
): Promise<ModelResult> {
  return callModel(llm, systemPrompt, [{ role: "user", content: userMessage }], modelOverride);
}
