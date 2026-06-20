# multiagent-framework

Build a multi-agent system entirely from YAML config files and prompt
files — no application code to write. Pick a design pattern, define your
agents and their prompts, wire up a workflow (with loops if needed), and run
it.

## Install

```bash
npm install
cp .env.example .env   # then put your ANTHROPIC_API_KEY in .env
```

## Run an example

```bash
npm run run -- configs/example-sequential.yaml
npm run run -- configs/example-supervisor.yaml
npm run run -- configs/example-parallel.yaml
npm run run -- configs/example-hierarchical.yaml
```

Or build once and run the compiled CLI:

```bash
npm run build
node dist/index.js configs/example-sequential.yaml
node dist/index.js configs/example-sequential.yaml --output draft   # print just one variable
```

## 1. Choosing a pattern

Set `pattern` at the top of your config to one of:

| pattern        | shape                                                            | use when |
|----------------|-------------------------------------------------------------------|----------|
| `sequential`   | fixed pipeline, agent A → B → C, optionally looping a sub-section | a known multi-step process (research → draft → review) |
| `supervisor`   | one supervisor agent dynamically delegates to worker agents       | the steps aren't fixed in advance; an agent should decide who does what, and when the task is done |
| `parallel`     | several agents run concurrently on the same input, then an aggregator merges results | independent perspectives/sub-tasks that don't depend on each other (fan-out / fan-in) |
| `hierarchical` | nested supervisors — a root supervisor delegates to team-lead agents, which delegate to their own workers | org-chart-shaped problems, large worker counts you want to group |

Each pattern requires its own matching top-level config block:
`workflow` (sequential), `supervisorConfig` (supervisor), `parallel` (parallel),
`hierarchical` (hierarchical).

## 2. Config file syntax

A config is one YAML file. Top-level fields:

```yaml
name: string                # just a label, shown in logs
pattern: sequential | supervisor | parallel | hierarchical
goal: string                # the overall objective; available as {{goal}} in templates

llm:                         # optional, these are the defaults
  provider: anthropic
  model: claude-sonnet-4-6
  apiKeyEnv: ANTHROPIC_API_KEY   # env var name holding the API key
  maxTokens: 2048
  temperature: 1

agents:                      # every agent used anywhere in the config
  - id: my_agent              # referenced elsewhere by this id
    role: "Human-readable name"   # optional, defaults to id
    description: "What this agent does, in one line"  # see Section 6
    prompt: "inline system prompt"        # OR...
    promptFile: prompts/my_agent.md       # ...path relative to this config file
    model: claude-haiku-4-5               # optional, overrides llm.model for just this agent
    isSupervisor: true                    # supervisor/hierarchical patterns only
    workers: [a, b]                       # supervisor pattern: ids this agent may call
    team: [a, b]                          # hierarchical pattern: ids this agent may delegate to
    shouldExecute: "..."                  # see Section 7
    validate: { ... }                     # see Section 8
```

Each agent needs exactly one of `prompt` (inline) or `promptFile` (external
file, see [Section 5](#5-prompts)).

## 3. Workflows (`sequential` pattern)

```yaml
workflow:
  steps:
    - agent: researcher       # must match an agents[].id
      input: "{{goal}}"        # template string, see below
      output: notes            # store the agent's reply under this variable name
    - agent: writer
      input: "Notes: {{notes}}"
      output: draft
```

Templates support `{{goal}}` and `{{<any previously produced output var>}}`.
Referencing a variable that hasn't been produced yet resolves to an empty
string (useful inside loops — see below) rather than erroring.

## 4. Loops

**Sequential pattern** — wrap a subset of steps (by their `output` name) in
a `loop` block; it re-runs just those steps until a condition is met or a
turn cap is hit:

```yaml
workflow:
  steps: [...]
  loop:
    steps: [draft, review]              # which steps (by output name) to repeat
    until: "vars.review.includes('APPROVED')"   # JS boolean expression; `vars` and `goal` are in scope
    maxIterations: 3
    tokenBudget: 50000        # optional second safety net, measured in tokens instead of turns
    onExhaustion: lastAttempt  # "lastAttempt" (keep going, default) or "fail" (throw)
    statusVar: loop_status     # optional; records "approved" or a *_EXCEEDED message
```

Omit `steps` to loop the entire `workflow.steps` list. A loop with a generator
step and a critic step is the **Adversarial-Verify** pattern — generator and
critic alternate until the critic accepts, bounded by `maxIterations` and
(optionally) `tokenBudget` so the back-and-forth can't run away. See
`configs/example-sequential.yaml`.

**Supervisor / hierarchical patterns** — looping is implicit: the supervisor
agent itself decides, turn by turn, whether to call another worker or finish.
`maxTurns` (`supervisorConfig.maxTurns` / `hierarchical.maxTurns`) is the turn
safety cap; `tokenBudget` on either config is a second cap measured in tokens
spent by the supervisor and everything it delegates to. Either one being
exceeded produces the same kind of structured signal as above (see Section
11).

## 5. Prompts

Prompts are plain text/Markdown files referenced from `agents[].promptFile`,
resolved relative to the config file's own directory (so configs and their
prompts can live side by side, see `configs/` + `prompts/` in this repo). Use
`prompt: "..."` instead for short inline prompts.

For `supervisor` and `hierarchical` patterns, the supervisor/team-lead agent's
prompt **must** instruct it to reply with a delimiter-based decision block —
see `prompts/supervisor.md` and `prompts/team_lead.md` for the exact contract
the orchestrator expects (plain JSON breaks down once a payload contains
unescaped multi-line code, so this protocol uses `<<< >>>` markers instead):

```
ACTION: call
WORKER: <id>
MESSAGE:
<<<
...any content, including code, quotes, or newlines...
>>>
```

```
ACTION: finish
RESULT:
<<<
...the final deliverable...
>>>
```

(`hierarchical` uses `ACTION: delegate` / `MEMBER:` instead of `ACTION: call`
/ `WORKER:` — see `prompts/ceo.md` and `prompts/team_lead.md`.)

## 6. Keeping supervisors thin as agent count grows

A supervisor's prompt file (`prompts/supervisor.md` / `team_lead.md` /
`ceo.md`) never lists worker ids or describes what they do — that would mean
editing the supervisor's prompt every time you add an agent. Instead, each
agent declares its own `description`, and the orchestrator builds the
worker/team roster from config at runtime:

```yaml
agents:
  - id: coder
    description: "Writes TypeScript implementation code given a spec"
  - id: tester
    description: "Writes unit tests for a given piece of code"
```

The supervisor sees a generated roster (`- coder: Writes TypeScript...`,
`- tester: Writes unit tests...`) and picks based on those descriptions using
its own judgment. Going from 3 workers to 50 means adding 47 `agents[]`
entries with descriptions — the supervisor's prompt and the orchestrator code
that builds the roster both stay exactly the same size.

## 7. `shouldExecute` — agents own their own eligibility

Add `shouldExecute` to any agent to give it a guard condition, evaluated
against `vars` and `goal`, that decides whether it's willing to run at all:

```yaml
agents:
  - id: tester
    shouldExecute: "goal.toLowerCase().includes('test')"
```

If the condition is false, the framework skips calling the model entirely —
the agent is reported as having "declined." In `supervisor`/`hierarchical`
patterns, a decline is reported back to the calling supervisor as a message
(`"[tester declined]: its shouldExecute condition was not met"`), so the
supervisor can route to someone else. The supervisor's prompt and code never
encode *why* an agent might decline — that logic lives entirely with the
agent that owns it.

## 8. `validate` — agents check their own output before it goes upstream

Add `validate` to any agent to make it check its own output before handing
it to whatever's downstream (the next pipeline step, the calling supervisor,
or the aggregator):

```yaml
agents:
  - id: coder
    validate:
      type: rule                 # "rule" (JS expression) or "llm" (LLM judge)
      rule: "output.includes('function')"
      maxRetries: 1               # re-prompt the agent with feedback this many times
      onFail: warn                # "warn" (log + proceed) or "fail" (throw)
```

For `type: llm`, use `criteria` (plain English) instead of `rule`:

```yaml
validate:
  type: llm
  criteria: "Must acknowledge both upside and downside considerations."
  onFail: warn
```

On failure, if `maxRetries > 0` the agent is re-prompted with the rejection
reason appended and tries again. Once retries are exhausted, `onFail: warn`
logs a warning and passes the output through anyway; `onFail: fail` marks the
result as a failure (see Section 9) — what happens next depends on the
pattern: a `sequential` step hard-stops the whole run (later steps likely
depend on this one's output), while `supervisor`/`hierarchical`/`parallel`
patterns route around it instead of crashing. This is opt-in and entirely
per-agent — an agent with no `validate` block always passes through
unchecked, and no caller needs to know or care which agents validate
themselves.

## 9. Typed handoffs — agents never fail silently

Every call to `agent.execute()` (used for pipeline steps, supervisor/team
worker calls, and parallel fan-out) returns one of three explicit statuses
instead of throwing:

| status | meaning |
|---|---|
| `ok` | ran successfully, output passed validation (or has none) |
| `skipped` | `shouldExecute` was false — the agent declined |
| `error` | validation failed with `onFail: fail`, or an unexpected runtime error occurred (e.g. a network failure) |

`execute()` itself never throws — a worker hitting an error becomes a typed
result the *caller* sees and can react to:

- **`supervisor`/`hierarchical`**: an `error` or `skipped` worker result is
  reported back into the conversation as `[workerId error]: <reason>` or
  `[workerId declined]: <reason>`, so the supervisor's own LLM judgment can
  route to a different worker, retry, or give up — the framework doesn't
  decide that for it.
- **`parallel`**: a failed/declined agent is excluded from aggregation (with
  a logged warning); the run only fails outright if *every* fan-out agent
  fails.
- **`sequential`**: an `error` status is a hard stop — later steps' templates
  likely depend on this step's output, so silently continuing with a bad or
  empty value would corrupt downstream state. The thrown error includes the
  failure reason.

## 10. Context-window discipline

`supervisor` and `hierarchical` patterns hold a running conversation between
the supervisor and its workers across turns. Rather than appending every
turn's full output forever (which grows the prompt without bound and
eventually confuses the model with stale state), only the most recent
`contextWindowTurns` exchanges are kept verbatim; older ones are collapsed to
a one-line summary:

```yaml
supervisorConfig:
  ...
  contextWindowTurns: 6   # default; also available on `hierarchical:`
```

## 11. Budget exhaustion

If a `supervisor`/`hierarchical` node hits `maxTurns` or its optional
`tokenBudget` without finishing, the run doesn't crash. It returns a
clearly-marked partial result instead, naming which budget ran out:

```
TURN_BUDGET_EXCEEDED: supervisor "lead" did not finish within maxTurns=8.

Last exchange:
...
```

```
TOKEN_BUDGET_EXCEEDED: supervisor "lead" spent 41203 tokens (budget 40000) without finishing.

Last exchange:
...
```

This is written to the configured `output` variable (or bubbled up to a
parent supervisor in `hierarchical`, which can react to it like any other
worker response) — never silently treated as a successful finish. The
`sequential` pattern's loop produces the analogous `MAX_ITERATIONS_EXCEEDED`
/ `TOKEN_BUDGET_EXCEEDED` signals into `statusVar` if one is configured (see
Section 4).

## 12. Observability — `--trace`

Pass `--trace <file>` to append a JSON-lines log of every model call (agent
id, event type, latency, input/output token counts, and the full input/output
text) to a file, so a run can be inspected or replayed after the fact instead
of only living in console output:

```bash
npm run run -- configs/example-supervisor.yaml --trace run.jsonl
```

## 13. Running it

```
npm run run -- <path-to-config.yaml> [--output <varName>]
```

This is the whole "application" — there's nothing else to build. Point the
CLI at any config file that follows this syntax and it executes that
multi-agent system end to end, printing every variable produced (or just one,
with `--output`).

## 14. Pattern-specific config reference

### `parallel`

```yaml
parallel:
  agents: [optimist, skeptic]   # run concurrently, same input
  input: "{{goal}}"
  aggregator: synthesizer       # combines all responses into one
  output: final_output
```

### `supervisor`

```yaml
supervisorConfig:
  supervisor: lead
  workers: [coder, tester]
  input: "{{goal}}"
  maxTurns: 8
  output: final_output
```

### `hierarchical`

```yaml
hierarchical:
  rootSupervisor: ceo
  input: "{{goal}}"
  maxTurns: 6
  output: final_output
```

Nesting comes from each agent's `team` field — any team member can itself be
`isSupervisor: true` with its own `team`, to arbitrary depth.

## Adding your own multi-agent system

1. Copy one of the `configs/example-*.yaml` files that matches your pattern.
2. Write prompt files for your agents under `prompts/` (or inline them).
3. Wire up `workflow` / `supervisorConfig` / `parallel` / `hierarchical`.
4. `npm run run -- configs/your-config.yaml`
