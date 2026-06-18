// Delimiter-based decision protocol used by supervisor/hierarchical agents.
// JSON breaks down once payloads contain unescaped multi-line code or quotes,
// so we use plain markers instead:
//
//   ACTION: call
//   WORKER: coder
//   MESSAGE:
//   <<<
//   ...freeform content, any newlines/quotes/backticks allowed...
//   >>>
//
//   ACTION: finish
//   RESULT:
//   <<<
//   ...freeform content...
//   >>>
//
// (hierarchical uses ACTION: delegate / MEMBER: instead of WORKER:)

export interface Decision {
  action: string;
  target?: string; // worker id (supervisor) or member id (hierarchical)
  payload: string; // message (call/delegate) or result (finish)
}

export function parseDecision(raw: string, targetField: "WORKER" | "MEMBER"): Decision {
  const actionMatch = raw.match(/ACTION:\s*(\w+)/i);
  if (!actionMatch) {
    throw new Error(
      `Response did not contain an "ACTION:" line. Its prompt must instruct it to reply using the ` +
        `ACTION/${targetField}/MESSAGE or ACTION/RESULT delimiter protocol.\nGot:\n${raw}`,
    );
  }
  const action = actionMatch[1].toLowerCase();

  // Prefer a properly closed block; fall back to "everything after <<<" in
  // case the response got truncated (e.g. hit max_tokens) before the closing
  // ">>>" was written, so a long result isn't silently dropped.
  const closedMatch = raw.match(/<<<([\s\S]*?)>>>/);
  const openMatch = raw.match(/<<<([\s\S]*)$/);
  const payload = (closedMatch ?? openMatch)?.[1]?.trim() ?? "";

  const targetMatch = raw.match(new RegExp(`${targetField}:\\s*(\\S+)`, "i"));

  return { action, target: targetMatch?.[1], payload };
}
