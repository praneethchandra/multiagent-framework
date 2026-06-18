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
    prompt: "inline system prompt"        # OR...
    promptFile: prompts/my_agent.md       # ...path relative to this config file
    model: claude-haiku-4-5               # optional, overrides llm.model for just this agent
    isSupervisor: true                    # supervisor/hierarchical patterns only
    workers: [a, b]                       # supervisor pattern: ids this agent may call
    team: [a, b]                          # hierarchical pattern: ids this agent may delegate to
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
```

Omit `steps` to loop the entire `workflow.steps` list.

**Supervisor / hierarchical patterns** — looping is implicit: the supervisor
agent itself decides, turn by turn, whether to call another worker or finish
(`maxTurns` / `supervisorConfig.maxTurns` / `hierarchical.maxTurns` is the
safety cap).

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

## 6. Running it

```
npm run run -- <path-to-config.yaml> [--output <varName>]
```

This is the whole "application" — there's nothing else to build. Point the
CLI at any config file that follows this syntax and it executes that
multi-agent system end to end, printing every variable produced (or just one,
with `--output`).

## Pattern-specific config reference

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
