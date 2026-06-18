import { RunContext } from "./types.js";

// Replaces {{goal}} and {{varName}} with values from the run context.
export function renderTemplate(template: string, ctx: RunContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    if (key === "goal") return ctx.goal;
    // Vars produced inside a loop body don't exist yet on the first pass
    // (e.g. a "review" var referenced by the step that produces the very
    // first draft) -- substitute empty string rather than failing.
    return ctx.vars[key] ?? "";
  });
}

// Evaluates a small boolean expression against the run context, e.g.
//   "vars.review.includes('APPROVED')"
// This is intentionally a thin sandbox: configs are authored by the same
// person running the framework, not untrusted third parties.
export function evalCondition(expr: string, ctx: RunContext): boolean {
  const fn = new Function("vars", "goal", `return Boolean(${expr});`);
  return fn(ctx.vars, ctx.goal);
}
