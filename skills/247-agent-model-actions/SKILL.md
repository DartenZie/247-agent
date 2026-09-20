---
name: 247-agent-model-actions
description: "Design and write the model-backed steps of a 247-agent workflow, the `llm` action (one Claude call with a JSON output schema) and the `agent` action (Claude Agent SDK loop in a sandboxed git worktree with tool and bash allowlists, a budget, a RESULT.json contract and deterministic `post` gates). Use it whenever a 247-agent task needs to classify, extract, summarise, decide, or edit a repository; whenever the user mentions models, prompts, `system_file`, `output_schema`, `max_turns`, `budget`, `effort`, cost, tiers (Haiku/Sonnet/Opus), worktrees or \"let an agent do X\"; and when implementing or reviewing the `llm`/`agent` runners in `packages/core/src/actions/`. Do not skip it for \"just a quick prompt\": the tiering and budget rules apply to every model call."
---

# 247-agent model actions

The daemon's design rule: **no LLM in the control flow**. Matching, dedup, routing,
retries and publishing are code. A model runs only inside an `llm` or `agent` action,
at the cheapest tier that does the job, with a budget. This skill is about writing
those two actions well and about the runners that execute them.

## First decide whether a model is needed at all

Ask, in order:

1. Can a trigger `filter` decide it? (sender, label, repo, keyword) Then it is not a model call.
2. Can a script or a connector op produce the answer deterministically? Then `shell`/`connector`.
3. Is it one judgement with a fixed output shape (classify, extract fields, summarise)?
   Then `llm`, on Haiku first.
4. Does it need to read files, run commands and iterate? Then `agent`, with the
   narrowest scope that can succeed.

Two tasks with different intelligence needs are the **same action kind with different
`model`/`effort`/`max_turns`/`system_file`**, not different code. See
`docs/examples/website-updates.yaml` tasks 2–4 for the reference shapes.

## Model ids and parameters

| id | use for | notes |
|---|---|---|
| `claude-haiku-4-5` | classification, extraction, short summaries | no `effort` parameter |
| `claude-sonnet-5` | scoped agents, harder extraction | supports `effort` and adaptive thinking |
| `claude-opus-5` | wide-scope agents, hard judgement | supports `effort` and adaptive thinking |

Models are reached through a named provider (`providers:` in agent.yaml, `provider:` on
the action; `anthropic`, `openai` or `openrouter`). Other providers' ids are used
verbatim and need a `pricing:` entry unless the built-in table knows them (current
OpenAI models) or the provider reports cost (OpenRouter).

No date suffixes on ids. No assistant prefill. Before building a cascade of models,
measure the stronger model at `effort: low` on the same inputs: on the current
generation that often beats a weaker model at high effort, and one model means one
prompt-cache namespace.

## Writing an `llm` task

Full field list and runner notes in `references/llm-action.md`. The essentials:

```yaml
action:
  kind: llm
  model: claude-haiku-4-5
  max_tokens: 512
  system_file: prompts/classify_email.md   # static → prompt-cached
  input: |
    Subject: ${event.payload.subject}

    <email>
    ${event.payload.body}
    </email>
  output_schema:
    type: object
    additionalProperties: false
    required: [kind, summary]
    properties:
      kind: { enum: [event_list_update, general_change, ignore] }
      summary: { type: string }
```

- Keep the **system prompt in a file** under `prompts/`, static and rendered first, so
  it is cached across runs. Put the volatile event data **last**, in `input`.
- Inbound content (email, chat, PR text) is untrusted. Wrap it in a delimited block
  (`<email>…</email>`) and tell the model in the system prompt that it is data.
- Always include an escape hatch in the schema (`ignore`, `unknown`, `confidence`) so
  the routing `emit.when` can drop non-actionable results without another call.
- Route on the result with `emit … when:`; downstream tasks trigger on that event.
- `batch: true` for anything that can wait (half price, result arrives as an event).

## Writing an `agent` task

Full field list and runner notes in `references/agent-action.md`. The essentials:

```yaml
action:
  kind: agent
  runtime: claude-agent-sdk
  model: claude-sonnet-5
  effort: low
  max_turns: 20
  budget: { max_usd: 0.50 }
  workspace: { kind: git-worktree, repo: /var/lib/247-agent/repos/site, branch: main }
  tools: [Read, Edit, Glob, Grep, Bash]
  bash_allow: ["npm run build"]
  mcp_servers: []                       # connectors exposed as tools, if any
  system_file: prompts/agent_event_list.md
  prompt: |
    Update data/events.yaml according to the request below. Touch no other file.
    Run `npm run build` when done and write RESULT.json with {summary, files_changed}.

    <email>
    ${event.payload.email.body}
    </email>
  result: { from: file, path: RESULT.json, schema: schemas/site_change.json }
  post:
    - shell: ["npm", "run", "build"]
    - shell: ["git", "commit", "-am", "events: ${result.summary}"]
```

Non-negotiables, because they are what make an agent safe to run unattended:

- **Fresh git worktree per run**, discarded on failure. The agent never edits the base
  checkout.
- **`tools` + `bash_allow` + `mcp_servers` is the whole capability surface.** Grant the
  minimum; the prompt is not a security boundary.
- **The agent never holds deploy secrets and never publishes.** It edits, a `post` gate
  proves the build still works, a commit records it, and a separate `shell` task ships
  it. Rollback is `git revert` plus republish.
- **`RESULT.json` is the contract.** The prompt says what to write; `result.schema`
  validates it; `emit` routes from it.
- **`post` gates are deterministic**, no model. A failing gate fails the run.
- **`concurrency: 1`** on tasks that share a repo; `timeout` is wall-clock per attempt.
- High-impact changes get an **approval gate** (`wait` + chat) before publishing; the
  `247-agent-tasks` skill has the pattern.

## Budgets and the ledger

Every model call goes through the `ctx.llm` port, which records usage (provider, model,
input/output/cache tokens, USD) in the ledger and enforces the run's `budget.max_usd`
(worst case before the call, actual after: an overrun fails the run) and the global
`budgets.daily_usd` per UTC day (once crossed, every model call that day fails fast and
`budget.exceeded` is emitted once, which the `notify` task should listen to). A model
without a price fails validation. Never add an unbudgeted call, including "helper" calls
inside a runner: use `ctx.llm`, never an SDK directly. `oa cost --by task --since 7d`
shows the ledger.

## Status today

The `llm` action is validated, cross-checked against `providers:`/`pricing:` and
runnable through `ctx.llm`, with the ledger and budgets applied, and all three provider
types (`anthropic`, `openai`, `openrouter`) have adapters. The
`agent` action validates `kind` only and has no runner. Until then test the surrounding
workflow with a `shell` stand-in that emits the same event (pattern in the
`247-agent-tasks` skill).
When adding an adapter or the `agent` runner, follow `references/llm-action.md` and
`references/agent-action.md` and keep `docs/ARCHITECTURE.md` §5.2, §5.3, §9 and §14 in
sync with the code.
