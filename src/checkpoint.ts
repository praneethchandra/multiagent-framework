import fs from "node:fs";
import { TokenUsage } from "./types.js";
import { TranscriptEntry } from "./transcript.js";

// Checkpoint-Resume (spec: "persists the agent's state... so recovery
// resumes from the last good checkpoint rather than restarting from
// scratch"). Full support ships for `sequential` (resume by pre-loop step
// index) and `supervisor` (resume by turn count + the exact transcript, so
// the supervisor's conversation history is preserved). `hierarchical`'s
// recursive nested state isn't checkpointed mid-run -- that's a documented
// gap, not a silent one: see README Section 16.
export interface CheckpointData {
  vars: Record<string, string>;
  tokenUsage: TokenUsage;
  sequential?: { preStepsCompleted: number };
  supervisor?: { turn: number; transcript: TranscriptEntry[] };
}

export type CheckpointWriter = (partial: Omit<CheckpointData, "vars" | "tokenUsage">) => void;

export function makeCheckpointWriter(
  filePath: string | undefined,
  vars: Record<string, string>,
  tokenUsage: TokenUsage,
): CheckpointWriter | undefined {
  if (!filePath) return undefined;
  return (partial) => {
    const data: CheckpointData = { vars, tokenUsage, ...partial };
    // Write to a temp file then rename -- avoids a half-written checkpoint
    // if the process is killed mid-write.
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  };
}

export function loadCheckpoint(filePath: string): CheckpointData | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as CheckpointData;
}
