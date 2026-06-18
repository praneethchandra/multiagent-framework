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

// Evaluates a small JS expression against an arbitrary scope of named values,
// e.g. evalExpr("output.length > 20", { output, vars, goal }).
// This is intentionally a thin sandbox: configs are authored by the same
// person running the framework, not untrusted third parties.
export function evalExpr(expr: string, scope: Record<string, unknown>): unknown {
  const keys = Object.keys(scope);
  const fn = new Function(...keys, `return (${expr});`);
  return fn(...keys.map((k) => scope[k]));
}

// Evaluates a boolean expression against the run context (`vars`, `goal` in
// scope), e.g. "vars.review.includes('APPROVED')".
export function evalCondition(expr: string, ctx: RunContext): boolean {
  return Boolean(evalExpr(expr, { vars: ctx.vars, goal: ctx.goal }));
}
