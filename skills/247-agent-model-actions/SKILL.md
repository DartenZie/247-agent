---
name: 247-agent-model-actions
description: "Design and write the model-backed steps of a 247-agent workflow: the `decide` action (typed questions to TypeSafe's Jev classifier via OpenRouter's Decisions API, probabilities back, no text), the `llm` action (one Claude call with a JSON output schema) and the `agent` action (one session on an ACP agent such as claude-agent-acp, in a fresh git worktree, with tool-kind and command allowlists, a tool-call cap, a budget, a RESULT.json contract with `status: done | blocked` and deterministic `post` gates). Use it whenever a 247-agent task needs to classify, route, triage, extract, summarise, decide, or edit a repository; whenever the user mentions models, prompts, `system_file`, `output_schema`, `questions`, `criteria`, confidence thresholds, Jev, `max_tool_calls`, `budget`, `effort`, cost, tiers (Haiku/Sonnet/Opus), ACP, worktrees, \"blocked\" results or \"let an agent do X\"; and when implementing or reviewing the `llm`/`decide`/`agent` runners in `packages/core/src/actions/`. Do not skip it for \"just a quick prompt\": the tiering and budget rules apply to every model call."
---

# 247-agent model actions

The daemon's design rule: **no LLM in the control flow**. Matching, dedup, routing,
retries and publishing are code. A model runs only inside a `decide`, `llm` or `agent`
action, at the cheapest tier that does the job, with a budget. This skill is about
writing those three actions well and about the runners that execute them.

## First decide whether a model is needed at all

Ask, in order:

1. Can a trigger `filter` decide it? (sender, label, repo, keyword) Then it is not a model call.
2. Can a script or a connector op produce the answer deterministically? Then `shell`/`connector`.
3. Is it a label, a yes/no or a level, with no text to produce (classify, route, triage,
   gate)? Then `decide`: a classification-only model, calibrated probabilities, about a
   hundredth of an `llm` call.
4. Is it one judgement with a fixed output shape that needs text (extract fields,
   summarise, draft)? Then `llm`, on Haiku first.
5. Does it need to read files, run commands and iterate? Then `agent`, with the
   narrowest scope that can succeed.

Two tasks with different intelligence needs are the **same action kind with different
`model`/`effort`/`max_tool_calls`/`system_file`**, not different code. See
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

## Writing a `decide` task

Full field list, wire notes and pitfalls in `references/decide-action.md`. The essentials:

```yaml
action:
  kind: decide
  provider: openrouter                 # must be an openrouter provider; default defaults.decide.provider
  budget: { max_usd: 0.001 }
  state:                               # what is judged; strings templated, keys not
    subject: ${event.payload.subject}
    body: ${event.payload.body}
  questions:                           # static policy; no ${…} here
    kind:
      type: choice
      instructions: What does the sender want done with the website?
      criteria:
        event_list_update: Add, remove or change an entry in the events list
        general_change: Any other change to the site
        ignore: Not a change request (question, thanks, spam)
    urgent:
      type: noul
      instructions: Does the sender need this done today?
```

- The result is the answers map: `result.kind.choice`, `result.kind.confidence`,
  `result.urgent.noul` (P(true)), `result.<score>.score` (probability-weighted mean of
  the level indexes). Route with `emit … when:`; the **threshold lives in the task**,
  never in the runner, and is calibrated on real data.
- **Always include a fallback label** (`ignore`, `other`): without one, off-topic input
  gets a confident wrong answer.
- Criteria are followed literally: they are policy, version them like code. Keep the
  option order stable (it shifts confidence). Ask several questions in one call; each
  extra one costs only its own tokens.
- Inbound content is data: it goes in `state`, never in a question. The whole request
  must fit in 32k tokens.
- Only the `openrouter` provider type reaches Jev (`typesafe/jev-1.13`, the default
  model); `oa validate` refuses any other. No `pricing:` entry is needed.

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
  connector: claude                     # a transport: acp connector (connectors.d/claude.yaml; sandbox: bwrap there)
  max_tool_calls: 20
  budget: { max_usd: 0.50 }
  workspace: { kind: git-worktree, repo: /var/lib/247-agent/repos/site, branch: main }
  tools: [read, edit, search, execute]  # ACP tool kinds; everything else is refused
  bash_allow: ["npm run build"]         # what `execute` may run
  system_file: prompts/agent_event_list.md
  prompt: |
    Update data/events.yaml according to the request below. Touch no other file.
    Run `npm run build` when done.

    <email>
    ${event.payload.email.body}
    </email>
  result: { path: RESULT.json, schema: schemas/site_change.json }
  post:                                 # only after status: done
    - shell: ["npm", "run", "build"]
    - shell: ["git", "commit", "-am", "events: ${result.summary}"]
emit:
  - type: site.change_blocked           # the agent could not do it: say what is missing
    when: "result.status == 'blocked'"
    payload: { summary: ${result.summary}, missing: ${result.missing}, email: ${event.payload.email} }
```

Non-negotiables, because they are what make an agent safe to run unattended:

- **Fresh workspace per run** (`git-worktree` on branch `agent/<run_id>`, or `temp`),
  removed on failure, kept on success. The agent never edits the base checkout.
- **`tools` + `bash_allow` is the whole capability surface**, judged per permission
  request and never granted "always"; a tool call the agent ran without asking is judged
  after the fact and a violation fails the run (`unasked_execute: sandboxed` relaxes only
  the command check, only for Codex, whose own sandbox confines what it does not ask
  about). Grant the minimum; the prompt is not a security boundary. (`mcp_servers` must
  stay empty until the MCP proxy exists.)
- **The agent never holds deploy secrets and never publishes.** It edits, a `post` gate
  proves the build still works, a commit records it, and a separate `shell` task ships
  it. Rollback is `git revert` plus republish. The model key lives in the connector
  manifest's `env`, not in the task.
- **`RESULT.json` is the contract**, and the runner states it in every prompt:
  `status: done | blocked` plus `summary`, then the task's `result.schema`. `done` runs
  the gates; `blocked` skips them and the run still succeeds, so `emit … when:
  "result.status == 'blocked'"` routes "not done because X is missing" to a reply task.
  Design every agent task with both branches.
- **`post` gates are deterministic**, no model. A failing gate fails the run.
- **`max_tool_calls` and `budget` are hard stops** (the session is cancelled); a turn the
  agent does not report usage or cost for fails the run.
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
inside a runner: use `ctx.llm`, never an SDK directly. An `agent` turn is the one case
where the model is called by someone else (the ACP agent, with its own key): the runner
ledgers what the agent reports through `ctx.llm.record` under the connector's name and
cancels the session when the reported cost passes the cap. `oa cost --by task --since 7d`
shows the ledger.

## Status today

The `llm` action is validated, cross-checked against `providers:`/`pricing:` and
runnable through `ctx.llm`, with the ledger and budgets applied, and all three provider
types (`anthropic`, `openai`, `openrouter`) have adapters. The `decide` action runs
through the same port (`ctx.llm.decide()`), with the Decisions API implemented in the
`openrouter` adapter only; `docs/examples/decide-triage.yaml` is the reference. The
`agent` action runs on ACP connectors (`transport: acp`); `docs/examples/website-updates.yaml`
tasks 3, 3b and 4 are the reference, `docs/examples/connectors.d/claude.yaml` the
connector. Not there yet: `mcp_servers` (connector ops as agent tools), transcript
persistence, and exposing the agent's model/mode config options. `work/<run_id>` of a
finished run is swept `retention.workspaces` (default 7d) after it finished.
When adding an adapter or changing a runner, follow `references/llm-action.md`,
`references/decide-action.md` and `references/agent-action.md` and keep
`docs/ARCHITECTURE.md` §5.2, §5.3, §5.4, §9 and §14 in sync with the code.
