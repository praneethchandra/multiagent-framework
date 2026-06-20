// Context-window discipline (spec #9 / anti-pattern 5.3 "flat context
// accumulation"): a supervisor's conversation with its workers must not grow
// without bound. Entries older than the window are collapsed to a one-line
// summary; only the most recent `windowSize` entries are kept verbatim.
export interface TranscriptEntry {
  speaker: string;
  content: string;
}

export class Transcript {
  private entries: TranscriptEntry[] = [];

  constructor(private readonly header: string, private readonly windowSize: number) {}

  add(speaker: string, content: string): void {
    this.entries.push({ speaker, content });
  }

  render(): string {
    const total = this.entries.length;
    const cutoff = Math.max(0, total - this.windowSize);
    const older = this.entries.slice(0, cutoff);
    const recent = this.entries.slice(cutoff);

    const parts = [this.header];

    if (older.length > 0) {
      const summary = older
        .map((e) => `${e.speaker} (${e.content.length} chars): ${e.content.slice(0, 100).replace(/\s+/g, " ")}...`)
        .join("\n");
      parts.push(`[Earlier exchanges, summarized to save context]\n${summary}`);
    }

    for (const e of recent) {
      parts.push(`[${e.speaker}]:\n${e.content}`);
    }

    return parts.join("\n\n");
  }

  tail(maxChars = 1000): string {
    const last = this.entries[this.entries.length - 1];
    if (!last) return "(no exchanges yet)";
    return last.content.length > maxChars ? last.content.slice(0, maxChars) + "..." : last.content;
  }
}
