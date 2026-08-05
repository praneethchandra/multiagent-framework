import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGraph } from "../../patterns/graph.js";
import type { AgentGraphConfig, RunContext } from "../../types.js";
import type { Agent } from "../../agent.js";

// Minimal Agent stub that returns a fixed output.
function makeAgent(output: string): Agent {
  return {
    execute: vi.fn().mockResolvedValue({ status: "ok", output, attempts: 1 }),
  } as unknown as Agent;
}

function makeCtx(vars: Record<string, string> = {}): RunContext {
  return { vars, goal: "test goal", tokenUsage: { input: 0, output: 0 } };
}

const log = vi.fn();
beforeEach(() => log.mockClear());

describe("runGraph — sequential chain", () => {
  it("executes two nodes in order and stores outputs in vars", async () => {
    const planner  = makeAgent("research A and B");
    const merger   = makeAgent("final synthesis");
    const agents   = new Map([["planner", planner], ["merger", merger]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "merged", maxTurns: 10,
      nodes: [
        { id: "plan", agentId: "planner", type: "planner", input: "{{goal}}", output: "plan" },
        { id: "merge", agentId: "merger", type: "aggregator", input: "Plan: {{plan}}", output: "merged" },
      ],
      edges: [
        { from: "plan", to: "merge", type: "sequential" },
      ],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(ctx.vars["plan"]).toBe("research A and B");
    expect(ctx.vars["merged"]).toBe("final synthesis");
    expect(planner.execute).toHaveBeenCalledTimes(1);
    expect(merger.execute).toHaveBeenCalledTimes(1);
  });

  it("passes rendered template as input to downstream node", async () => {
    const a = makeAgent("output-A");
    const b = makeAgent("output-B");
    const agents = new Map([["a", a], ["b", b]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "b_out", maxTurns: 10,
      nodes: [
        { id: "nodeA", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" },
        { id: "nodeB", agentId: "b", type: "worker", input: "Previous: {{a_out}}", output: "b_out" },
      ],
      edges: [{ from: "nodeA", to: "nodeB", type: "sequential" }],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    const bCall = (b.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bCall[1]).toBe("Previous: output-A");
  });
});

describe("runGraph — parallel fan-out", () => {
  it("runs parallel nodes concurrently then feeds aggregator", async () => {
    const planner  = makeAgent("the plan");
    const resA     = makeAgent("findings A");
    const resB     = makeAgent("findings B");
    const merger   = makeAgent("merged result");
    const agents   = new Map([
      ["planner", planner], ["resA", resA], ["resB", resB], ["merger", merger],
    ]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "merged", maxTurns: 10,
      nodes: [
        { id: "plan",  agentId: "planner", type: "planner",    input: "{{goal}}",                 output: "plan" },
        { id: "rA",    agentId: "resA",    type: "worker",     input: "Plan: {{plan}} — topic A", output: "res_a" },
        { id: "rB",    agentId: "resB",    type: "worker",     input: "Plan: {{plan}} — topic B", output: "res_b" },
        { id: "merge", agentId: "merger",  type: "aggregator", input: "A={{res_a}} B={{res_b}}",  output: "merged" },
      ],
      edges: [
        { from: "plan",        to: ["rA", "rB"], type: "parallel" },
        { from: ["rA", "rB"],  to: "merge",      type: "sequential" },
      ],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(ctx.vars["res_a"]).toBe("findings A");
    expect(ctx.vars["res_b"]).toBe("findings B");
    expect(ctx.vars["merged"]).toBe("merged result");
    expect(resA.execute).toHaveBeenCalledTimes(1);
    expect(resB.execute).toHaveBeenCalledTimes(1);
    expect(merger.execute).toHaveBeenCalledTimes(1);
  });
});

describe("runGraph — conditional edges", () => {
  it("executes node when 'when' condition is true", async () => {
    const validator = makeAgent("looks good");
    const merger    = makeAgent("final");
    const agents    = new Map([["validator", validator], ["merger", merger]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "final", maxTurns: 10,
      nodes: [
        { id: "val",   agentId: "validator", type: "validator",  input: "{{goal}}", output: "validation" },
        { id: "merge", agentId: "merger",    type: "aggregator", input: "{{validation}}", output: "final" },
      ],
      edges: [
        { from: "val", to: "merge", type: "conditional", when: "vars.validation.length > 0" },
      ],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(ctx.vars["final"]).toBe("final");
    expect(merger.execute).toHaveBeenCalledTimes(1);
  });

  it("skips node when 'when' condition is false", async () => {
    const validator = makeAgent("draft output");
    const merger    = makeAgent("should not run");
    const agents    = new Map([["validator", validator], ["merger", merger]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "final", maxTurns: 10,
      nodes: [
        { id: "val",   agentId: "validator", type: "validator",  input: "{{goal}}", output: "validation" },
        { id: "merge", agentId: "merger",    type: "aggregator", input: "{{validation}}", output: "final" },
      ],
      edges: [
        { from: "val", to: "merge", type: "conditional", when: "vars.validation.includes('APPROVED')" },
      ],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(merger.execute).not.toHaveBeenCalled();
    expect(ctx.vars["final"]).toBeUndefined();
  });

  it("downstream of skipped conditional node is also skipped", async () => {
    const a = makeAgent("output");
    const b = makeAgent("should skip");
    const c = makeAgent("should also skip");
    const agents = new Map([["a", a], ["b", b], ["c", c]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "c_out", maxTurns: 10,
      nodes: [
        { id: "na", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" },
        { id: "nb", agentId: "b", type: "worker", input: "{{a_out}}", output: "b_out" },
        { id: "nc", agentId: "c", type: "worker", input: "{{b_out}}", output: "c_out" },
      ],
      edges: [
        { from: "na", to: "nb", type: "conditional", when: "false" },
        { from: "nb", to: "nc", type: "sequential" },
      ],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(b.execute).not.toHaveBeenCalled();
    expect(c.execute).not.toHaveBeenCalled();
  });
});

describe("runGraph — human_gate node", () => {
  it("human_gate node writes stdin answer to output var", async () => {
    const researchAgent = makeAgent("research done");
    const agents = new Map([["researcher", researchAgent]]);

    // Mock stdin
    const { askHuman } = await import("../../humanInput.js");
    vi.spyOn({ askHuman }, "askHuman" as never);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "approval", maxTurns: 10,
      nodes: [
        { id: "research", agentId: "researcher", type: "worker",     input: "{{goal}}",        output: "draft" },
        { id: "approve",                          type: "human_gate", input: "Review: {{draft}}", output: "approval" },
      ],
      edges: [{ from: "research", to: "approve", type: "human_gate" }],
    };

    // Stub askHuman for test
    vi.mock("../../humanInput.js", () => ({
      askHuman: vi.fn().mockResolvedValue("APPROVED"),
    }));

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(ctx.vars["draft"]).toBe("research done");
    // human_gate stores the answer
    expect(ctx.vars["approval"]).toBe("APPROVED");
  });
});

describe("runGraph — stateSchema validation", () => {
  it("logs warning for missing stateSchema key after execution", async () => {
    const a = makeAgent("output");
    const agents = new Map([["a", a]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "a_out", maxTurns: 10,
      nodes: [
        { id: "na", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" },
      ],
      edges: [],
      stateSchema: { a_out: "string", missing_key: "string" },
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    const warnCalls = log.mock.calls.map(c => c[0] as string).filter(m => m.includes("missing_key"));
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it("does not warn when all stateSchema keys are present", async () => {
    const a = makeAgent("output");
    const agents = new Map([["a", a]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "a_out", maxTurns: 10,
      nodes: [{ id: "na", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" }],
      edges: [],
      stateSchema: { a_out: "string" },
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    const warnCalls = log.mock.calls.map(c => c[0] as string).filter(m => m.includes("WARNING"));
    expect(warnCalls.length).toBe(0);
  });
});

describe("runGraph — maxTurns budget", () => {
  it("stops executing when maxTurns is exhausted", async () => {
    const a = makeAgent("out-a");
    const b = makeAgent("out-b");
    const agents = new Map([["a", a], ["b", b]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "b_out", maxTurns: 1,  // only 1 turn allowed
      nodes: [
        { id: "na", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" },
        { id: "nb", agentId: "b", type: "worker", input: "{{a_out}}", output: "b_out" },
      ],
      edges: [{ from: "na", to: "nb", type: "sequential" }],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(b.execute).not.toHaveBeenCalled();

    const budgetLogs = log.mock.calls.map(c => c[0] as string).filter(m => m.includes("TURN_BUDGET_EXCEEDED"));
    expect(budgetLogs.length).toBeGreaterThan(0);
  });
});

describe("runGraph — isolated root nodes run without edges", () => {
  it("single node with no edges executes and stores output", async () => {
    const a = makeAgent("solo result");
    const agents = new Map([["a", a]]);

    const config: AgentGraphConfig = {
      input: "{{goal}}", output: "a_out", maxTurns: 10,
      nodes: [{ id: "na", agentId: "a", type: "worker", input: "{{goal}}", output: "a_out" }],
      edges: [],
    };

    const ctx = makeCtx();
    await runGraph(config, agents, ctx, log);

    expect(ctx.vars["a_out"]).toBe("solo result");
  });
});
