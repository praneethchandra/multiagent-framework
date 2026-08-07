import { describe, it, expect, vi } from "vitest";
import { runRouter } from "../../patterns/router.js";
import { Agent } from "../../agent.js";
import { RouterConfig, RunContext, AgentConfig } from "../../types.js";

// Minimal stub that resolves immediately with a fixed output.
function makeAgent(id: string, output: string): Agent {
  return {
    id,
    execute: vi.fn().mockResolvedValue({ status: "ok", output, attempts: 1 }),
  } as unknown as Agent;
}

function makeCtx(vars: Record<string, string> = {}): RunContext {
  return { vars: { ...vars }, goal: "test goal", tokenUsage: { input: 0, output: 0 } };
}

const noop = () => {};

describe("router pattern", () => {
  it("classifies and dispatches to a sequential route", async () => {
    const classifier = makeAgent("classifier", "research");
    const researcher = makeAgent("researcher", "found some facts");
    const writer     = makeAgent("writer",     "here is the report");

    const agents = new Map<string, Agent>([
      ["classifier", classifier],
      ["researcher", researcher],
      ["writer",     writer],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        research: {
          pattern: "sequential",
          workflow: {
            steps: [
              { agent: "researcher", input: "{{goal}}", output: "findings" },
              { agent: "writer",     input: "{{findings}}", output: "final_output" },
            ],
          },
        },
      },
    };

    const ctx = makeCtx();
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(ctx.vars.route).toBe("research");
    expect(ctx.vars.findings).toBe("found some facts");
    expect(ctx.vars.final_output).toBe("here is the report");
  });

  it("falls back to default route when classifier output matches no key", async () => {
    const classifier = makeAgent("classifier", "unknown_domain");
    const fallback   = makeAgent("fallback_agent", "generic answer");

    const agents = new Map<string, Agent>([
      ["classifier",    classifier],
      ["fallback_agent", fallback],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        legal: {
          pattern: "sequential",
          workflow: { steps: [{ agent: "fallback_agent", input: "{{goal}}", output: "final_output" }] },
        },
      },
      default: {
        pattern: "sequential",
        workflow: { steps: [{ agent: "fallback_agent", input: "{{goal}}", output: "final_output" }] },
      },
    };

    const ctx = makeCtx();
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(ctx.vars.route).toBe("unknown_domain");
    expect(ctx.vars.final_output).toBe("generic answer");
  });

  it("throws when no route matches and no default is configured", async () => {
    const classifier = makeAgent("classifier", "finance");
    const agents = new Map<string, Agent>([["classifier", classifier]]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        legal: {
          pattern: "sequential",
          workflow: { steps: [] },
        },
      },
    };

    await expect(runRouter(config, agents, new Map(), makeCtx(), noop))
      .rejects.toThrow(/no route matched/);
  });

  it("stores route key in the configured routeVar", async () => {
    const classifier = makeAgent("classifier", "legal");
    const legalAgent = makeAgent("legal_agent", "legal answer");

    const agents = new Map<string, Agent>([
      ["classifier", classifier],
      ["legal_agent", legalAgent],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "selected_workflow",  // custom var name
      output: "final_output",
      routes: {
        legal: {
          pattern: "sequential",
          workflow: { steps: [{ agent: "legal_agent", input: "{{goal}}", output: "final_output" }] },
        },
      },
    };

    const ctx = makeCtx();
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(ctx.vars.selected_workflow).toBe("legal");
    expect(ctx.vars.final_output).toBe("legal answer");
  });

  it("dispatches to parallel route and runs all agents", async () => {
    const classifier  = makeAgent("classifier",  "analysis");
    const agentA      = makeAgent("agent_a",      "result A");
    const agentB      = makeAgent("agent_b",      "result B");
    const aggregator  = makeAgent("aggregator",   "combined");

    const agents = new Map<string, Agent>([
      ["classifier",  classifier],
      ["agent_a",     agentA],
      ["agent_b",     agentB],
      ["aggregator",  aggregator],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        analysis: {
          pattern: "parallel",
          parallel: {
            agents: ["agent_a", "agent_b"],
            input: "{{goal}}",
            aggregator: "aggregator",
            output: "final_output",
          },
        },
      },
    };

    const ctx = makeCtx();
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(ctx.vars.route).toBe("analysis");
    expect(ctx.vars.final_output).toBe("combined");
  });

  it("throws when classifier agent is unknown", async () => {
    const config: RouterConfig = {
      classifier: "nonexistent",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {},
    };

    await expect(runRouter(config, new Map(), new Map(), makeCtx(), noop))
      .rejects.toThrow(/classifier agent "nonexistent" not found/);
  });

  it("throws when route pattern block is missing (sequential without workflow)", async () => {
    const classifier = makeAgent("classifier", "legal");
    const agents = new Map<string, Agent>([["classifier", classifier]]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        legal: {
          pattern: "sequential",
          // no workflow block — should throw
        },
      },
    };

    await expect(runRouter(config, agents, new Map(), makeCtx(), noop))
      .rejects.toThrow(/no workflow block/);
  });

  it("renders {{vars}} in classifier input template", async () => {
    const classifier = makeAgent("classifier", "healthcare");
    const handler    = makeAgent("healthcare_agent", "medical answer");

    const agents = new Map<string, Agent>([
      ["classifier",      classifier],
      ["healthcare_agent", handler],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "Route this query for domain {{domain}}: {{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        healthcare: {
          pattern: "sequential",
          workflow: { steps: [{ agent: "healthcare_agent", input: "{{goal}}", output: "final_output" }] },
        },
      },
    };

    const ctx = makeCtx({ domain: "medical" });
    await runRouter(config, agents, new Map(), ctx, noop);

    // Verify classifier received rendered input
    expect(classifier.execute).toHaveBeenCalledWith(
      expect.anything(),
      "Route this query for domain medical: test goal",
      noop,
    );
    expect(ctx.vars.final_output).toBe("medical answer");
  });

  it("case-insensitive route key matching (classifier may return mixed case)", async () => {
    const classifier = makeAgent("classifier", "Legal");  // capital L
    const legalAgent = makeAgent("legal_agent", "legal result");

    const agents = new Map<string, Agent>([
      ["classifier", classifier],
      ["legal_agent", legalAgent],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        legal: {  // lowercase key
          pattern: "sequential",
          workflow: { steps: [{ agent: "legal_agent", input: "{{goal}}", output: "final_output" }] },
        },
      },
    };

    const ctx = makeCtx();
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(ctx.vars.route).toBe("legal");
    expect(ctx.vars.final_output).toBe("legal result");
  });

  it("passes prior vars into sequential route steps as template context", async () => {
    const classifier = makeAgent("classifier", "finance");
    const analyst    = makeAgent("analyst", "risk: low");

    const agents = new Map<string, Agent>([
      ["classifier", classifier],
      ["analyst",    analyst],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        finance: {
          pattern: "sequential",
          workflow: {
            steps: [
              {
                agent:  "analyst",
                input:  "Analyze for customer {{customerId}}: {{goal}}",
                output: "final_output",
              },
            ],
          },
        },
      },
    };

    const ctx = makeCtx({ customerId: "C-9001" });
    await runRouter(config, agents, new Map(), ctx, noop);

    expect(analyst.execute).toHaveBeenCalledWith(
      expect.anything(),
      "Analyze for customer C-9001: test goal",
      noop,
    );
  });

  it("logs classifier selection and route execution", async () => {
    const classifier = makeAgent("classifier", "research");
    const agent      = makeAgent("researcher", "facts");

    const agents = new Map<string, Agent>([
      ["classifier", classifier],
      ["researcher", agent],
    ]);

    const config: RouterConfig = {
      classifier: "classifier",
      input: "{{goal}}",
      routeVar: "route",
      output: "final_output",
      routes: {
        research: {
          pattern: "sequential",
          workflow: { steps: [{ agent: "researcher", input: "{{goal}}", output: "final_output" }] },
        },
      },
    };

    const logs: string[] = [];
    await runRouter(config, agents, new Map(), makeCtx(), (msg) => logs.push(msg));

    expect(logs.some(l => l.includes("classifying"))).toBe(true);
    expect(logs.some(l => l.includes("research"))).toBe(true);
    expect(logs.some(l => l.includes("complete"))).toBe(true);
  });
});
