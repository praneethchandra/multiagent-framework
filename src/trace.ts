import fs from "node:fs";

// Structured observability log (spec #8): every model call is appended as
// one JSON line capturing inputs, outputs, latency, and token usage, so a
// run can be replayed and audited after the fact instead of only living in
// console output.
export interface TraceEvent {
  ts: string;
  agentId: string;
  event: "call" | "validate";
  attempt?: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  input: string;
  output: string;
}

let sink: fs.WriteStream | null = null;

export function initTrace(filePath?: string): void {
  sink = filePath ? fs.createWriteStream(filePath, { flags: "a" }) : null;
}

export function trace(event: TraceEvent): void {
  if (!sink) return;
  sink.write(JSON.stringify(event) + "\n");
}

export function closeTrace(): Promise<void> {
  return new Promise((resolve) => {
    if (!sink) return resolve();
    sink.end(() => resolve());
  });
}
