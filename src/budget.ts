import { RunContext } from "./types.js";

// Snapshot the run's cumulative token count, so a loop/supervisor can later
// ask "how many tokens have *I* spent" rather than "how many has the whole
// run spent" -- each scope's tokenBudget is relative to its own start.
export function tokenBaseline(ctx: RunContext): number {
  return ctx.tokenUsage.input + ctx.tokenUsage.output;
}

export function tokensSince(ctx: RunContext, baseline: number): number {
  return tokenBaseline(ctx) - baseline;
}
