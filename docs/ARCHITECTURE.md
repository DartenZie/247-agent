# Online-Agent — Architecture

A 24/7, config-driven automation daemon for a Linux server. Deterministic work runs as
code; the LLM is called only where judgement is needed, at the cheapest tier that does
the job.

## 1. Goals and non-goals

Goals

- **Everything is a task in a config file.** A task = one trigger + one action + routing
  of its result. No code changes to add a workflow.
- **Three action tiers with very different cost:** `shell` (no LLM), `llm` (one model call,
  no loop), `agent` (agentic loop with tools). Plus `connector` (call a sub-program op)
  and `wait` (block until an event, e.g. human approval).
- **Sub-programs ("connectors") plug into the core through one interface**, in any language.
- **Cheap by construction:** filtering, deduplication, routing, publishing and retries never
  touch a model. Every model call has a model, effort, turn and token budget in config.
- **Durable and observable:** every event and run is persisted; a crash never loses an
  email or re-runs a finished job.

Non-goals

- Not a general workflow engine with a UI (see §2 for why we don't adopt one).
- Not multi-node. One server, one process, SQLite. Scale-out is out of scope.

## 2. Reuse vs. build

| Candidate | Verdict |
|---|---|
| n8n / Node-RED / Windmill / Huginn | Trigger→action model fits, but they are UI-first, workflows are opaque JSON, and "an agent that edits a checkout and runs a build" is awkward to express. Heavy runtime (Postgres, Node) for one server. |
| Temporal / Airflow / Prefect | Durable orchestration, but workflows are code (Temporal) or batch DAGs (Airflow). Overkill and not config-driven. |
| systemd timers + scripts | Fine for cron, no event chaining, no state, no LLM budgets. |
| Anthropic Managed Agents (scheduled deployments) | Solid option for the `agent` tier if you prefer Anthropic to host the sandbox. Rejected as the *core* because the FTP target, credentials and site checkout live on your server, and cost control wants local gating. A hosted agent that speaks ACP would plug in as one more `transport: acp` connector (§5.4). |

**Decision:** build a small core (~2–3k lines) and reuse aggressively underneath it:

- **systemd** for process supervision, timers are *not* used (the core owns cron so it can
  emit events).
- **SQLite (WAL)** as event log, run history, KV state and cost ledger.
- **MCP (Model Context Protocol)** as the *operations* half of the connector interface.
  Existing MCP servers (GitHub, Jira, IMAP, filesystem…) become connectors for free.
- **Anthropic Messages API** with structured outputs for `llm` actions, behind one small
  provider interface (`packages/core/src/llm/`) that OpenAI and OpenRouter adapters share;
  the core prices, budgets and ledgers every call itself, so adding a provider is one
  adapter file.
- **Agent Client Protocol (ACP, agentclientprotocol.com)** as the agent loop for `agent`
  actions: any ACP agent program (`claude-agent-acp`, `gemini --experimental-acp`,
  `codex-acp`, …) is a connector with `transport: acp`, the core is the client
  (`@agentclientprotocol/sdk`), and the loop, file edits, shell, per-call permission
  requests, cancellation and usage reporting are the protocol's. Swapping the agent is a
  manifest change.
- **croner** (cron parsing/scheduling), **zod** (config schema + validation, and the
  same schemas feed `betaZodTool` / structured outputs), **jmespath** (expressions),
  **better-sqlite3** (synchronous SQLite, WAL), **@modelcontextprotocol/sdk** (MCP client
  for connector ops), **execa** (subprocesses).

Language: **TypeScript on Node.js 22 LTS** (decided). Reasons: `@anthropic-ai/sdk`, the
MCP reference SDK and the ACP SDK are TypeScript, and the agent programs are mostly Node
programs, so one runtime serves core, agents and most connectors. Connectors and agents
remain language-agnostic (§6).

## 3. Core concepts

```
Connector ──emits──▶ Event ──matches──▶ Trigger ──starts──▶ Run(Task) ──result──▶ Event(s)
   ▲                                                            │
   └──────────────── ops (MCP tool calls) ◀──────────────────────┘
```

**Event** — the only thing that flows through the system.

```json
{ "id": "evt_01J…", "type": "email.received", "source": "email",
  "ts": "2026-09-19T10:00:00Z", "correlation_id": "cor_…",
  "parent_id": "evt_…", "dedup_key": "email:<msg-id>", "depth": 0,
  "payload": { "from": "…", "subject": "…", "body": "…" } }
```

- `correlation_id` threads one real-world happening (an email) through every task it
  triggers, so runs, costs and logs can be traced end-to-end and approvals can resume.
- `dedup_key` makes delivery idempotent: a second event with the same key is dropped.
- `source` is the connector name, `scheduler`, `manual`, or `task:<name>` for events produced
  by a task's runs. **A task never triggers on events with its own `task:<name>` source**, so
  `notify` on `task.*.failed` cannot loop on its own failure.
- `depth` counts hops from the root of a causal chain (via `parent_id`). The dispatcher drops
  events deeper than `limits.max_event_depth` (default 32) as a runaway-loop guard.

**Trigger** — what starts a task.

| kind | config | produces |
|---|---|---|
| `cron` | `schedule: "*/5 * * * *"`, optional `tz`, `overlap: skip\|allow` | each tick is a `cron.tick` event (`payload: {task, scheduled_at}`, `dedup_key: cron:<task>:<scheduled_at>`); one run per tick, skipped while a run of the task is queued, running or waiting unless `overlap: allow`. Ticks missed while the daemon was down are not replayed. |
| `event` | `type: email.received` (or `type_any: [...]`, globs allowed: `task.*.failed`, `*` = exactly one dot-separated segment), optional `filter: <JMESPath>` evaluated against the whole event with JMESPath truthiness | one run per matching event |
| `manual` | — | no automatic trigger. **Any** task can be run by hand: `oa run <task>` publishes a `manual.run` event (`payload: {task, event?}`) that bypasses filters and overlap |

"Output of another task" is just an `event` trigger on `task.<name>.succeeded` or on any
event the task emitted. Tasks never reference each other directly; they are decoupled
through event types. That is what makes the config composable.

**Task** — `name`, `trigger`, `action`, `emit` (routing of the result), plus policy:
`timeout`, `retry`, `concurrency`, `budget`, `on_failure`.

**Run** — one execution of a task for one event. Persisted with status
`queued | running | waiting | succeeded | failed | cancelled`, input event, result,
usage/cost, logs, and the agent transcript if any.

**Connector** — a separate process that can (a) emit events into the core and/or
(b) expose operations as MCP tools. §6.

## 4. Runtime components

One daemon, `247-agent-core`, with these internal modules:

| Module | Responsibility |
|---|---|
| **Config loader** | Reads `agent.yaml` + `tasks.d/*.yaml` + `connectors.d/*.yaml`, validates against schema, hot-reloads on SIGHUP or `POST /v1/reload` (`oa reload`): all three together or nothing. Everything in `agent.yaml` but `db`, `socket` and `secrets` applies live (workers, defaults, providers, pricing, budgets, retention, log level, limits); those three are reported as `restart_required`. Connectors whose manifest changed are respawned, new ones spawned, removed ones stopped, unchanged ones untouched; running runs finish under the config they started with. An invalid file on reload is logged and the previous config stays active. |
| **Scheduler** | Cron → `cron.tick` events (with task name in payload). |
| **Event store / bus** | Append-only `events` table. Publishing = insert. Dispatch loop reads a cursor, matches triggers, enqueues runs, advances the cursor, all in one transaction. At-least-once + `dedup_key` + `UNIQUE(task, event_id)` = effectively once. A task never matches events whose `source` is its own `task:<name>`; events deeper than `limits.max_event_depth` are dropped. The same loop ends `wait`s: an event matching a waiting run's wait, or a wait past its timeout (checked on every dispatch, so within the 1s safety-net interval), re-queues the run. |
| **Matcher** | Evaluates `trigger.filter` (JMESPath) against the event. Filters are pure, cheap, and where most "is this relevant?" logic should live (sender address, label, repo name). A filter that throws at run time counts as no match and is logged. |
| **Executor** | Worker pool. Enforces per-task and global concurrency, timeouts, retries with backoff, budgets. Resolves the secrets a task names, delegates to an *action runner* per kind, then applies `state_updates` and `emit` in one transaction with the lifecycle event. |
| **State KV** | `state(namespace, key, value)` for connectors and tasks (IMAP cursor, last-seen PR number…). Tasks read it as `${state.<ns>.<key>}` (a snapshot taken at run start) and write it with `state_updates`; connectors use the API. |
| **Cost ledger** | One row per model call: provider, model, input/output/cache tokens, USD, how it was priced. Budgets are derived from it: `budget.max_usd` per run (worst case checked before the call, actual after), `budgets.daily_usd` per UTC day → circuit breaker (§9). The `llm` runner reaches it only through the `ctx.llm` port, which prices, budgets and writes the row in one place. |
| **API** | HTTP over a Unix socket (`/run/247-agent/core.sock`), plain `node:http`, JSON in and out: `GET /v1/health`, `POST /v1/events` (201 inserted / 200 duplicate), `GET /v1/events?type=&after=&limit=` (the newest `limit` in `seq` order, or those after a `seq`; `type` is an exact type or a trigger pattern), `GET /v1/events/{id}`, `POST /v1/runs` (manual run, 201), `GET /v1/runs?status=&task=&limit=` (newest first), `GET /v1/runs/{id}`, `GET /v1/runs/{id}/transcript?after=&limit=` (the agent transcript, §5.4), `GET /v1/runs/{id}/ledger` (its model calls and their total), `GET /v1/state/{ns}` (list), `GET|PUT|DELETE /v1/state/{ns}/{key}` (`PUT` body `{value}`), `GET /v1/connectors` (supervised processes and built-ins with state/pid/restarts), `POST /v1/connectors/{name}/restart` (kill, re-resolve secrets, respawn; 409 for a built-in), `POST /v1/reload` (the config reload above; 200 with `{ok, files, restart_required, connectors?, tasks}`, `ok: false` when refused), `GET /metrics` (Prometheus text exposition, `oa_*`: runs by task and status, run latency, events (labelled by type only when the core or a task names it exactly, else `other`), waits, cron ticks, model calls/tokens/USD and the day's spend against the cap, connector state, ops, restarts and health checks, retention counts, DB size, API requests). Errors are `{error, issues?}` with 400/404/405/413. A stale socket file left by a dead daemon is replaced at start; a live one refuses the start. Also what the CLI talks to. |
| **Connector supervisor** | Spawns configured connectors as child processes, holds one MCP stdio client per connector, restarts crashed ones with exponential backoff (`restart.base` doubling up to `restart.max`, reset after 30s up), passes the socket path, name, rendered config and secrets via env (an `acp` agent gets its `env` and name only, and runs inside `bwrap` when its manifest says `sandbox: bwrap`, §6). A `stdio` manifest with `health: { interval, timeout, failures }` is pinged (MCP `ping`) every `interval`; `failures` consecutive misses count as a crash (kill, respawn with backoff); the last check is in `GET /v1/connectors`. Deferring to systemd units is not implemented. |
| **Retention** | Once at start and every `retention.interval`: deletes finished runs older than `retention.runs` with their ledger rows and transcript, ledger rows older than `retention.ledger` (finished runs only), dispatched events older than `retention.events` that no run or wait references, and `work/<run_id>` directories of runs finished longer ago than `retention.workspaces` (or with no run; a git worktree is detached and its branch deleted). Active runs and their rows are never touched. Counts go to the log (`retention.purged`) and to `/metrics`. |

Everything is in-process and single-node on purpose. If a queue is ever needed, the event
store's dispatch loop is the only seam to replace (e.g. with NATS/Redis Streams).

## 5. Action types

All actions receive a **context**: `event` (the triggering event), `task` (config), `state`
(KV snapshot), `secrets` (only the names the task's templates use, resolved at run time),
and return a JSON **result** which the core turns into `task.<name>.succeeded` + any `emit`
events. Templates use `${ <JMESPath> }` against `{event, result, state, secrets, env, run,
item, steps}`: `event` is the trigger event (for `oa run --event`, the given event under the
`manual.run` event's ids), `result` exists in `emit`/`state_updates`, `item` inside an
`each` fan-out, `steps` inside a sequence, `run` is `{id, task, attempt, event_id,
correlation_id}`, `env` the daemon's environment (minus the secrets backend's variables).
A string that is exactly one `${…}` renders to the expression's raw value (`stdin:
${event.payload}` stays JSON); text around or between templates makes a string, with
non-strings JSON-encoded and `null` empty. `secrets` may only appear in actions, never in
`emit` or `state_updates`, and only as `secrets.<name>`; `oa validate` enforces both and
every template's syntax. Inside YAML flow mappings `{ … }` a template must be quoted
(`{ since_uid: "${state.email.last_uid}" }`) because `{` would start a nested map.

### 5.1 `shell` — deterministic step, zero LLM

```yaml
action:
  kind: shell
  cmd: ["lftp", "-e", "mirror -R --delete site/ /public_html; quit", "sftp://${secrets.ftp_user}@ftp.example.com"]
  cwd: ${state.site_worktree}
  env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
  stdin: ${event.payload}          # optional, JSON on stdin
  result: json_stdout | text_stdout | exit_code
  sandbox: none | bwrap            # default from defaults.sandbox in agent.yaml
```

Runs as the service user, with `timeout`, stdout/stderr captured into the run log.
`cmd`, `cwd` and `env` values render to strings, `stdin` to its raw value. Result is
parsed JSON from stdout when `result: json_stdout`. A `user:` override is not supported.

`sandbox: bwrap` wraps the command in bubblewrap (`packages/core/src/actions/sandbox.ts`):
own pid and ipc namespaces, `/usr`, `/lib`, `/lib64`, `/bin` and `/etc` read-only, the
install root (`OA_HOME`) and the daemon's Node read-only (so `PATH` resolves the bundled
tools, `node`, `npx`), a private `/tmp`, `cwd` as the only writable path (without `cwd`
the command runs in that `/tmp`), and an environment cleared down to the action's `env`
plus `PATH`, `HOME` and `LANG`. The directories of `agent.yaml`, the database, the socket
and a `file` secrets backend are replaced by an empty tmpfs, so the daemon's own files do
not show through the read-only `/etc` (a file whose directory cannot be masked, `/etc`
itself or the install root, is bound to `/dev/null` instead); `oa validate` refuses a
`cwd` or a bind that would show one of them. The runtime directory with the core socket, the
state directory and other processes are not visible. The long form
`sandbox: { backend: bwrap, ro_binds: [/srv/data], rw_binds: [], extra_args: [] }`
adds mounts and raw bwrap flags (`--unshare-net` for offline steps). Use it for every
step that runs untrusted code or content, per the trust model in §11; steps that hold
deploy secrets and need the network (publishing) run unsandboxed and keep the secret in
`env`, not argv.

### 5.2 `llm` — single model call, structured output, no loop

```yaml
action:
  kind: llm
  provider: anthropic              # a name from providers: in agent.yaml; default: defaults.llm.provider
  model: claude-haiku-4-5          # cheapest tier that passes the eval for this task
  effort: low                      # Opus/Sonnet 5 only; ignored on Haiku 4.5
  max_tokens: 512
  system_file: prompts/classify_email.md   # stable → prompt-cached; or `system:` inline
  budget: { max_usd: 0.05 }        # per run; the smaller of this and the task's budget applies
  input: |
    From: ${event.payload.from}
    Subject: ${event.payload.subject}

    ${event.payload.body}
  output_schema:                   # → output_config.format (structured outputs)
    type: object
    required: [kind, summary]
    additionalProperties: false
    properties:
      kind: { enum: [event_list_update, general_change, ignore] }
      summary: { type: string }
      confidence: { type: number }
```

The result is the parsed object when `output_schema` is given, otherwise `{ text }`. A
call that stops at `max_tokens` or is refused fails the run (non-retryable).

Providers are declared once in `agent.yaml` (§7) by name with a type (`anthropic`,
`openai`, `openrouter`), an API key that must be a `${secrets.<name>}` reference, and an
optional `base_url`/`headers`. Several providers of one type (two accounts, a proxy) are
fine. The runner never talks to an SDK: it hands the rendered request to the `ctx.llm`
port (`packages/core/src/llm/service.ts`), which resolves the key for that call, checks
the budgets, calls the adapter for the provider's type, writes the ledger row and returns
the result. Adapters (`llm/anthropic.ts` etc.) map one request/response shape onto the
vendor SDK: system block first with a cache breakpoint, the input as the user turn, the
schema as the structured-output format, no prefill; `effort` (and adaptive thinking on
Anthropic) only on models that take it; usage normalised so `input` is what the vendor
bills at the full input price and cache reads/writes are separate. `anthropic` uses the
Messages API, `openai` the Responses API (`instructions` + `text.format`, `store: false`),
`openrouter` the `openai` SDK against OpenRouter's Chat Completions endpoint, where the
per-response `usage.cost` is what the ledger records. The two OpenAI-style adapters send
the schema in strict mode, which the vendor only accepts when every property is listed in
`required` and every object has `additionalProperties: false`; a schema that does not
fails the call non-retryably with the vendor's message. A `batch: true` mode (Message
Batches at half price, results arriving async as events) is planned, not implemented.

### 5.3 `decide` — classification only, typed answers with probabilities

```yaml
action:
  kind: decide
  provider: openrouter             # must be an `openrouter` provider; default: defaults.decide.provider
  model: typesafe/jev-1.13         # default: defaults.decide.model (this value)
  budget: { max_usd: 0.001 }       # per run; the smaller of this and the task's budget applies
  state:                           # what is judged: a string, or an object/array; strings are templated
    subject: ${event.payload.subject}
    body: ${event.payload.body}
  questions:                       # static policy, no ${…}; one typed answer each
    kind:
      type: choice                 # one label; answer {type, choice, confidence, probabilities}
      instructions: What does the sender want done with the website?
      criteria: { event_list_update: "…", general_change: "…", ignore: "Not a change request" }
    urgent:
      type: noul                   # yes/no; answer {type, noul} = P(true), no confidence field
      instructions: Does the sender need this done today?
      criteria: { "true": "…", "false": "…" }   # both sides or neither
    anger:
      type: score                  # ordered levels, index 0 lowest; answer {type, score, confidence, probabilities}
      instructions: How upset is the sender?
      criteria: [Calm, Annoyed, Furious]
```

For the case where a workflow needs a judgement but no text: TypeSafe's Jev is a
classification-only model (no generation, ~0.4 s, $0.042 per Mtok of input, output free)
that returns calibrated probabilities instead of a JSON document. Where `llm` on Haiku
would do to classify, `decide` does it for a few hundredths of the price, and the
probabilities let the task act, confirm or escalate without a second call.

The result is the `answers` map keyed by the question ids, so `emit` routes on
`` result.kind.choice != 'ignore' && result.kind.confidence > `0.5` `` and forwards
`${result.urgent.noul}`. Thresholds are the task's decision, not the runner's: calibrate
them on labelled data. A `score` is the probability-weighted mean of the level indexes
(`1.05`, not a level name). Always give a `choice` a fallback label (`ignore`, `other`):
without one, out-of-taxonomy input gets a confident wrong answer. Criteria are policy the
model follows literally; version them like code. Inbound content is data: it goes in
`state`, never in the questions (the schema refuses `${…}` there).

The runner renders `state` (a whole-string `${event.payload}` injects the raw object,
object keys are never templated), calls `ctx.llm.decide()` and checks the reply: every
question answered with its own type, a `choice` inside the criteria, a `score` inside the
range; a mismatch is the provider's fault and retryable. The port applies the same
budgets, ledger row and breaker as an `llm` call (§9), with the worst case estimated from
the JSON body at input price and no output. Only the `openrouter` provider type serves
the Decisions API (`POST https://openrouter.ai/api/alpha/decisions`, a different protocol
from Chat Completions; Jev is absent from the models catalog and rejects
`/chat/completions`), so the cross-check refuses any other provider type. The adapter
sends `{model, state, questions}` with the same key and attribution headers, maps 429/5xx
to retryable errors and every other non-2xx (401 no key, 402 no credits, 413 state over
32k tokens) to non-retryable ones, and takes the reported `usage.cost` as the ledger
price (the built-in table knows Jev's price for the pre-call estimate). A `base_url` on
the provider keeps its origin: the Decisions path replaces `/api/v1`.

### 5.4 `agent` — one ACP session in a fresh workspace, with a result contract

```yaml
action:
  kind: agent
  connector: claude                # a `transport: acp` connector (§6); default defaults.agent.connector
  model: claude-sonnet-5           # optional: prices the reported tokens when the agent reports no cost
  max_tool_calls: 40               # the core cancels the session past this; default defaults.agent
  budget: { max_usd: 1.50 }        # hard stop: cancelled when the reported cost passes it; run → failed
  workspace:
    kind: git-worktree             # fresh worktree per run on branch agent/<run_id>; or { kind: temp }
    repo: /var/lib/247-agent/repos/website
    branch: main
  tools: [read, edit, search, execute]   # ACP tool kinds the agent may use; the rest is refused
  bash_allow: ["npm run build", "npm test", "git status", "git diff"]   # what `execute` may run
  unasked_execute: judge           # judge (default) | sandboxed: what an unasked `execute` call is held to
  mcp_servers: []                  # connector ops as agent tools: planned, must be empty today
  system_file: prompts/agent_event_list.md   # static; prepended to the prompt (ACP has no system channel)
  prompt: |
    Add/modify the events described in the email below in data/events.yaml
    and nothing else. Run `npm run build` before finishing.

    <email>${event.payload.body}</email>
  result:
    path: RESULT.json              # relative to the workspace (default)
    schema: schemas/site_change.json   # optional JSON Schema on top of the baseline
  post:                            # deterministic gates, no LLM; only after status: done
    - shell: ["npm", "run", "build"]
    - shell: ["git", "commit", "-am", "agent: ${result.summary}"]
      when: "result.files_changed"  # JMESPath over {event, result, state, env, run}
```

**Protocol.** The agent is a program speaking the Agent Client Protocol (JSON-RPC over
stdio, protocol version 1). The supervisor spawns it once like any connector and keeps
the connection (`initialize`); each run calls `session/new` with the workspace as `cwd`,
sends one `session/prompt` (the `system_file` text, the rendered `prompt`, and the
result contract below), consumes `session/update` notifications (message chunks, tool
calls, `usage_update`) and answers `session/request_permission` from the task's policy.
`session/cancel` is the hard stop. The agent runs the model with its own key (the
manifest's `env`); the core never talks to a model provider for an `agent` action.

**Policy (the capability surface).** Every permission request is judged per call, never
`allow_always`: the tool's kind must be in `tools`; an `execute` call's command
(`rawInput.command`, else the title) must be one of `bash_allow` exactly, or a linear
chain (`&&`, `||`, `|`, `;`, `&`) in which every segment is an entry or starts with one
followed by a space, with no redirection, substitution or line break anywhere (`<`, `>`,
backticks, `$(`, `${`; quoting does not exempt those). Chain operators are read with
shell quoting: inside single or double quotes, or backslash-escaped, they are an argument
of the segment's program, so `grep -E "a|b" data` passes under `["grep"]`, while
`git status && npm run build` needs both entries and `npm run build && curl … | sh` never
passes; an unterminated quote is refused. Every reported path must lie inside the
workspace. Anything else is
refused (`reject_once`, else `reject_always`, else the protocol's `cancelled` outcome)
and logged as `agent.permission`. `tools` + `bash_allow` is the whole surface; the prompt
is not a security boundary.

Agents do not ask about everything: Claude Code runs reads and read-only commands such
as `git status` and `git diff` on its own (list them in `bash_allow`), and Codex runs
every command its own OS sandbox admits (bwrap + seccomp on Linux: the cwd writable or
not, no network) without asking and asks only to escape it. So a tool call that reaches
`in_progress`, `completed` or `failed` with no permission
request is judged after the fact from what its `tool_call`/`tool_call_update` reported
(kind, `rawInput.command`, `locations`); a violation cancels the session, is logged as
`agent.policy_violation`, and fails the run without retry, so a result produced outside
the policy never routes. `unasked_execute` says how far that goes for an `execute` call:
`judge` (default, for agents that ask before every write such as Claude Code) holds its
command to `bash_allow` like one that asked; `sandboxed` (for Codex, whose unasked
commands are confined by its own sandbox, which is stronger than a string match) judges
only kind and paths, so an unlisted `sed -n 1,40p x`, a `&&` chain of reads, or an edit
and a build inside the worktree does not fail the run, while every call that asks is
judged in full whatever the setting. codex-acp (verified with 1.12.0) pins the session to
Codex's workspace-write sandbox regardless of `sandbox_mode`: the containment is that
sandbox (writes only inside the cwd, no network), not a per-call ask. Pair it with
`approval_policy: on-request` (`docs/examples/connectors.d/codex.yaml`), never with
`never` or `danger-full-access`. What the agent did not report cannot be judged (a shell call
with no `rawInput.command` is only checked by kind), and the tool has already run by
then: the check catches an agent that steps outside the policy, it does not prevent the
step. Prevention is the agent's own permission routing plus sandboxing (§11): prefer
agents and modes that ask.

**Limits and money.** Tool calls are counted from `tool_call` updates; past
`max_tool_calls` the session is cancelled and the run fails non-retryably. The agent's
`usage_update.cost` (cumulative) is watched during the turn: past the run's cap (the
smaller of the task's and the action's `budget.max_usd`) the session is cancelled and
the run fails as `BudgetExceededError`. Before the turn `ctx.llm.checkBudget` refuses on
the daily cap or a run already over its cap; after every turn `ctx.llm.record` writes one
ledger row under `provider = <connector name>` with the reported cost (`priced_by:
provider`) or, when the agent reports only tokens, the table price of `model`
(`priced_by: table`). A turn that reports neither fails the run (never an unbudgeted
call); `budgets.daily_usd` and `budget.exceeded` apply as to any model call (§9).

**Result contract.** The runner appends it to every prompt: the agent must leave
`result.path` (default `RESULT.json`) in the workspace, a JSON object with at least
`status: "done" | "blocked"` and `summary` (a sentence for a human). `done` means the
change is in the workspace: the `post` gates run in order (each a `shell` argv in the
workspace, templated over `result`, skipped when its `when` is falsy; a non-zero exit
fails the run). `blocked` means it could not be done and `summary` (plus whatever fields
the task's schema adds, e.g. `missing`) says why: the gates are skipped and the run
still **succeeds**, so `emit … when: "result.status == 'blocked'"` can route it to a
task that replies to the sender, files a question, or asks a human. `result.schema` is
validated on top of the baseline; the run result is the RESULT.json document, so
`${result.summary}`, `${result.files_changed}` are available to `emit` and `post`. A
missing file gets one nudge turn (same session, budgeted like the first); still missing
or invalid fails the run, which `retry` then repeats in a fresh workspace.

**Workspace.** `<defaults.agent.work_dir>/<run_id>` (default `work/` next to the
database), available as `${run.workspace}`. `git-worktree` runs `git worktree add -B
agent/<run_id> <path> <branch>` from `repo`; `temp` is an empty directory. It is removed
(worktree, branch and all) when the run fails and kept when it succeeds, `blocked`
included, for the gates, for a later publishing task and for inspection, until the
retention pass removes it `retention.workspaces` after the run finished (§7).

**Transcript.** Every session is persisted as rows of the `transcripts` table
(`run_id, ts, turn, kind, text, data`), written as the runner sees the session: the
`prompt` it sent (turn 1, the nudge as turn 2), the agent's `text` and `thought` chunks
coalesced into one row per message, each `tool_call` and `tool_call_update` (id, kind,
title, command, locations, status), every `permission` decision with its reason, each
`usage` report, the `stop` (reason and token counts), a `cancel` by the core (budget,
tool calls, policy, abort) and the `result` it read. A permission row can precede the
`tool_call` it answers: requests are answered as they arrive, updates queue behind the
loop. Secret values resolved for the run are replaced by `[secret:<name>]` before a row
is written (values under 4 characters are left alone), tool output is not recorded, and
a row's text is split past 64k characters. Writing is best effort: a failing store is
logged once (`agent.transcript_failed`) and the run continues. `GET
/v1/runs/{id}/transcript` and `oa runs logs <id>` (with `--follow` while the run is
active) read it back; no other action kind records one. The rows go with the run when
`retention.runs` deletes it (§4).

Notes

- The **agent never publishes**. It edits a worktree, a build gate proves it didn't break
  anything, a commit records it, and a separate `shell` task ships it. Rollback is
  `git revert` + republish.
- The **agent never sees deploy credentials**. Secrets are injected only into the actions
  that need them; the manifest's `env` carries the model key and nothing else.
- Two tasks with different intelligence needs are the same action kind with a different
  `connector`/`max_tool_calls`/`budget`/`system_file`; model and effort are the agent
  program's own settings until ACP config options are wired (planned).
- `post` gates run through the `shell` runner with `cwd` = workspace, so
  `defaults.sandbox: bwrap` applies to them. The agent program itself is sandboxed by its
  manifest's `sandbox: bwrap` (§6, §11), which is where the `ro_binds` for the
  repositories the worktrees come from live.

### 5.5 `connector` — call one operation on a sub-program

```yaml
action:
  kind: connector
  connector: email
  op: fetch_new                    # an MCP tool name
  args: { folder: INBOX, since_cursor: "${state.email_cursor}" }
```

This is how "cron → fetch emails" works without any LLM: the core is an MCP client. `args`
values are templated; the result is the tool's `structuredContent`, else its text content
parsed as JSON when it is JSON. An `isError` result or an op outside the manifest's `ops`
fails the run without retry; a connector that is down fails it with retry. Optional
`timeout` bounds the call (default 60s).

### 5.6 `wait` — suspend the run until an event arrives (human in the loop)

```yaml
action:
  kind: wait
  for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}' && payload.approved == `true`" }
  timeout: 24h
  on_timeout: fail
```

Combined with a `connector` action that calls `chat.ask("Apply this change? …")`, this is
an approval gate. The run sits in `waiting` in SQLite (the `waits` table), survives
restarts, and resumes when the chat connector emits the reply. `for.type` is a type pattern
(`*` = one segment); `for.filter` is rendered as a template first (so `${event.…}` is the
waiting run's own event), then evaluated as a JMESPath over each incoming event. Events
published after the run's trigger but before the wait was armed are checked too, so a reply
that races the asking step is not lost. The result is the matched event (`payload`, `id`,
`type`, …). On `timeout` (fired by the dispatch loop) the run fails without retry, or with
`on_timeout: succeed` gets `{timed_out: true}`. The task `timeout` bounds each stretch of
active work, not the time spent waiting.

### 5.7 `sequence` — a few steps in one run, without inventing events for each

```yaml
action:
  kind: sequence
  steps:
    - { kind: connector, connector: chat, op: ask, args: { text: "Approve?" } }
    - { kind: wait, for: { type: chat.reply, filter: "…" }, timeout: 24h }
    - { kind: shell, when: "steps[1].payload.approved == `true`", cmd: [git, push] }
```

Steps share one run and one workspace; `steps[i]` exposes earlier results (`null` for a
skipped step) to later steps' templates and `when` expressions, and the run result is
`{steps: [...]}`. Steps are `shell`, `connector` or `wait`, each with an optional `when`
(JMESPath over the scope). A `wait` step checkpoints the step index and earlier results;
after a restart or a retry the sequence continues from that step with the matched event.
Use it for tightly coupled steps (ask → wait → act). Use separate tasks and events for
anything that another workflow might want to reuse or observe.

### 5.8 Routing: `emit`

Every task emits `task.<name>.succeeded|failed` automatically. `emit` adds domain events,
including fan-out:

```yaml
emit:
  - type: email.received
    each: ${result.emails}         # one event per item
    dedup_key: "email:${item.message_id}"
    payload: ${item}
  - type: email.classified
    when: "result.kind != 'ignore'"
    payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

`when` is a JMESPath over `{event, result, state, env, run}`; `each` must be a single
`${…}` that renders to an array (`null` emits nothing; anything else fails the run). Emitted
events carry `source: task:<name>` and the trigger event as `parent_id`, so they inherit
its correlation id. Rendering happens before anything is written: a rule that cannot be
rendered fails the run (no retry) and nothing is emitted. `state_updates` (`<ns>.<key>:
value`) are applied in the same transaction.

## 6. Connector interface (sub-programs)

A connector is any executable with a manifest. It may implement one or both halves.

```yaml
# connectors.d/email.yaml
name: email
exec: ["247-agent-connector-email"]                  # argv; or any executable, any language
transport: stdio                                     # stdio = MCP server on stdin/stdout; none = emits only; acp = an agent (§5.4)
emits: [email.received]                              # documented, shape-checked
ops: [fetch_new, mark_read, send]                    # allowlist of MCP tools the core may call; [] = any
config:                                              # free-form, the connector's own schema
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming: { protocol: imap, host: imap.example.com, folder: INBOX }
  outgoing: { host: smtp.example.com, from: info@example.com, footer: "-- \nExample Team office" }
restart: { base: 1s, max: 60s }                      # crash backoff
health: { interval: 60s, timeout: 10s, failures: 3 } # MCP ping; 3 misses in a row = crash (stdio only)
```

`config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only. `cwd` is
relative to the manifest. Manifests live in `connectors.d/*.yaml` or inline in the
`connectors:` list of `agent.yaml`; names must be unique.

**Events out (connector → core):** `POST http://unix:/run/247-agent/core.sock/v1/events`
with the Event JSON (core assigns `id`/`ts`, honours `dedup_key`). A one-line curl in
any language. Push-style connectors (chat bots, webhooks) use this; poll-style ones don't
need it at all (next point).

**Ops in (core → connector):** the connector is an **MCP server**. The core holds one
client connection. Handing the same server to agent runs as tools (`mcp_servers`) is
planned: it needs a small stdio proxy so the agent never receives the connector's
secrets, and until then `mcp_servers` must be empty.

**Agents (core → agent):** a manifest with `transport: acp` is an **ACP agent** (§5.4):
the core is the client, the process serves sessions, not ops, and emits no events. It
gets the same lifecycle (spawn, `env` with secrets rendered, crash backoff, `oa
connector restart`), no `OA_CONFIG_JSON` is needed, and `oa connector list` shows it
with its transport.

```yaml
# connectors.d/claude.yaml
name: claude
exec: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
transport: acp
env: { ANTHROPIC_API_KEY: "${secrets.anthropic_api_key}" }
sandbox: { backend: bwrap, ro_binds: [/var/lib/247-agent/repos/website] }   # §11; acp only
```

**Sandboxing the agent program.** `sandbox` (the same `none | bwrap | { backend, ro_binds,
rw_binds, extra_args }` as a `shell` action, §5.1) is accepted on `acp` manifests only:
every other connector needs the core socket, which the sandbox hides. The supervisor then
spawns `bwrap … -- <exec>` once, for the life of the process, with: the OS and the install
read-only; `defaults.agent.work_dir` the only writable path, which holds every run's
workspace and the program's home, `<work_dir>/home/<name>` (`HOME`; npm and Claude Code
caches live there, the retention sweep ignores it); the manifest's `ro_binds`/`rw_binds`
(the repositories `git-worktree` workspaces come from, read-only unless the agent itself
commits); the directories of `agent.yaml`, the database, the socket and the secrets file
masked with an empty tmpfs; an environment of `PATH`, `HOME`, `LANG`, `OA_HOME`,
`OA_CONNECTOR_NAME` and the manifest's `env`, nothing of the daemon's. The runtime
directory (socket), the state directory, `/proc` of other processes and the daemon's
environment are not reachable, which is what §11 requires of the one process that runs
untrusted content. The network is shared: the agent must reach its model API, and bwrap
can only cut it off entirely (`extra_args: [--unshare-net]`); an allowlist would take a
filtering proxy and is not built. Because the process is shared by concurrent runs, the
sandbox is per program, not per run: an agent can see other runs' workspaces under
`work_dir`, as it already could in one process. `oa validate` refuses a `sandbox` bind or
a `work_dir` that contains the database, the socket, `agent.yaml` or the secrets file, a
`cwd` outside every bind, and an `agent` task whose `workspace.repo` the sandboxed
connector cannot see; a changed `work_dir` on reload respawns sandboxed agents, since
they mount the old one. An `acp` connector (sandboxed or not) gets no `OA_CORE_SOCKET`
and no `OA_CONFIG_JSON` (`config` is refused on it): the agent program is configured
through `env` alone. `oa connector list` shows `sandbox=bwrap`. Needs the `bubblewrap`
package and unprivileged user namespaces (§12); without `bwrap` the spawn fails and the
connector stays down with the error in `oa connector list`.

**Turning any MCP tool into an event source:** the built-in `poller` connector runs on a
cron, calls `connector.op`, diffs the result against KV by `item_key`, and emits one event
per new item. This is exactly the "cron → fetch emails → filter" flow, with the LLM
nowhere near it, and it makes off-the-shelf MCP servers (GitHub, Jira) usable as triggers
without writing a poller for each. A built-in is a manifest with `builtin` instead of
`exec`; it runs inside the core, has no process, and its `config` is the built-in's own:

```yaml
# connectors.d/github-prs.yaml
name: github_prs
builtin: poller
config:
  schedule: "*/5 * * * *"          # cron (5 or 6 fields), optional tz
  connector: github                # a process connector that serves the op
  op: list_pull_requests
  args: { owner: acme, repo: site, state: open }   # ${secrets.<name>} / ${env.<VAR>} allowed
  items: "pull_requests"           # JMESPath over the op result → array (default: the result)
  item_key: "number"               # JMESPath over one item → string or number
  event: github.pr_opened          # emitted once per new key, the item as payload
  first_run: emit                  # or skip: mark what exists as seen, emit nothing
  keep: 1000                       # seen keys remembered
```

Seen keys live in the KV as `state(<poller name>, seen)`, newest last; the events carry
`source: <poller name>` and `dedup_key: <poller name>:<key>`, so replaying by deleting
the state still cannot emit an item twice. A tick while a poll is in flight is skipped;
a failed poll (target down, op error, wrong result shape) is logged as `poller.failed`
and retried at the next tick. `oa validate` checks the target exists, is a process
connector and lists the op.

**State:** `GET/PUT /v1/state/{connector}/{key}` so connectors stay stateless processes
(IMAP UID cursor, last seen PR).

**Lifecycle:** spawned by the core supervisor. Env provided: `OA_CORE_SOCKET`,
`OA_CONNECTOR_NAME`, `OA_CONFIG_JSON` (the manifest's `config` with secrets rendered) and
the manifest's `env`, on top of a minimal inherited environment (`PATH`, `HOME`, …).
`connectorEnv()` removes `OA_CONFIG_JSON` from the process environment once read, so a
subprocess the connector spawns does not inherit the rendered secrets; connectors in
other languages should do the same. Stderr lines are logged as `connector.output`.
Secrets are resolved at spawn, so a rotated value reaches a running connector through
`oa connector restart <name>` (`POST /v1/connectors/{name}/restart`): the process is
killed, its secrets re-resolved, and it is respawned with the backoff counter reset. The
built-in poller re-resolves on every poll and needs no restart. A
`247-agent-connector@name` systemd unit for connectors that need their own privileges
is not implemented yet.

**SDK (`@247-agent/connector-sdk`):** `connectorEnv()`, `CoreClient` (`emitEvent`,
`getState`/`putState` in the connector's own namespace), `defineTool` +
`createConnectorServer` + `serveStdio`, or `runConnector({tools, setup})` for all of it. The
module has no local imports so Node can run a connector straight from TypeScript source.

Connectors: `email` (`connectors/email`, done: IMAP or POP3 in, SMTP out, ops `fetch_new`,
`mark_read`, `send`; the footer is appended to every outgoing mail; `README.md` there is
the config reference); `ftp` (`connectors/ftp`, done: SFTP, FTP or FTPS; ops `list`,
`stat`, `read`, `write`, `delete`, `rename`, `mkdir`, every path confined to a configured
`root`; no events, a task fans `list` out); `chat` (`connectors/chat`, done: a Telegram bot
over the Bot API with long polling, the `getUpdates` offset and the open questions kept in
state; emits `chat.message` for every message in the configured chat and `chat.reply`,
carrying the `correlation_id` an `ask` received, when a button is tapped or an option is
typed as a reply; ops `send`, `ask`; `backend: telegram` leaves room for Matrix). Planned:
`github`, `jira` (both thin wrappers or direct use of their official MCP servers +
`poller`), `webhook` (generic HTTP in), `poller` (built-in).

## 7. Configuration layout

```
/etc/247-agent/
  agent.yaml            # global: db path, workers, default model policy, budgets, secrets backend
  tasks.d/*.yaml        # one file per workflow (a list of tasks)
  connectors.d/*.yaml   # connector manifests
  prompts/*.md          # system prompts referenced by tasks (cached, versioned in git)
  schemas/*.json        # output schemas
/var/lib/247-agent/
  state.db              # SQLite: events, runs, state, ledger
  repos/                # bare/base checkouts used for agent worktrees
  work/<run_id>/        # per-run worktrees and artifacts (GC'd by retention policy)
/run/247-agent/core.sock
```

`agent.yaml` essentials:

```yaml
db: /var/lib/247-agent/state.db
socket: /run/247-agent/core.sock
tasks: [tasks.yaml, tasks.d]   # files and/or directories of *.yaml, merged; relative to agent.yaml
connectors: connectors.d       # manifest files/directories, or inline manifests
workers: 4
log: { level: info }
secrets: { backend: systemd-credentials }   # $CREDENTIALS_DIRECTORY/<name>; or { backend: env, prefix: OA_SECRET_ } (OA_SECRET_<NAME>); or { backend: file, path: secrets.yaml }
providers:                   # model providers by name; api_key is always a secret reference
  anthropic:  { type: anthropic, api_key: "${secrets.anthropic_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}", headers: { X-Title: 247-agent } }
pricing: {}                  # USD per Mtok per model, merged over the built-in table: { gpt-5-mini: { input: 0.25, output: 2 } }
defaults:
  llm:   { provider: anthropic, model: claude-haiku-4-5, max_tokens: 1024 }
  decide: { provider: openrouter, model: typesafe/jev-1.13 }   # `decide` actions; the provider must be an openrouter one
  agent: { connector: claude, max_tool_calls: 30, budget: { max_usd: 1.0 } }   # `agent` actions (§5.4); work_dir defaults to work/ next to db
  retry: { attempts: 3, backoff: exponential, base: 30s }
budgets:
  daily_usd: 10          # global circuit breaker → all llm/decide/agent tasks fail fast until 00:00 UTC, alert emitted
retention: { events: 90d, runs: 90d, ledger: 90d, workspaces: 7d, interval: 1h }   # durations or `never`; ledger defaults to runs and cannot exceed it; runs and ledger keep at least 1d (the daily cap sums today's rows)
limits: { max_event_depth: 32 }   # drop events deeper than this in a causal chain (loop guard)
```

Retention deletes in dependency order: a finished run's ledger rows go with the run, an
event only once no kept run references it (so a run older than `events` keeps its
trigger event), and `dedup_key` uniqueness only spans the events kept. Active runs, their
events and their workspaces are never touched, whatever the durations.

The whole `/etc/247-agent` tree is meant to live in a git repo; `oa validate` checks
it in CI. `oa validate` takes tasks files, connector manifests and `agent.yaml` files alike
(a file whose `tasks` is a list of tasks is a tasks file; one with `name` and `exec` is a
manifest) and follows `agent.yaml` to every tasks file and manifest it names, checking
task and connector names are unique across files. Given an `agent.yaml` it also
cross-checks every `llm` task against it: the provider exists, the model has a price
(unless the provider reports cost itself), `system_file` exists under the config
directory; and every `agent` task: `model` (when set) has a price, `system_file` and
`result.schema` exist under the config directory. The daemon runs the same check at
start and on reload, and warns at load when an `agent` task names a connector that is
not an acp one. `docs/examples/agent.yaml` is the reference.

## 8. Worked example: website updates from email

See `docs/examples/website-updates.yaml`. The flow and what each step costs:

| # | Task | Trigger | Action | LLM? |
|---|---|---|---|---|
| 1 | `fetch_email` | cron `*/2 * * * *` | `connector` email.fetch_new → emit `email.received` per mail | no |
| 2 | `classify_email` | `email.received` with filter `payload.from == 'editor@…'` | `llm` Haiku 4.5, schema `{kind, summary}` → emit `email.classified` | 1 call |
| 3 | `update_event_list` | `email.classified` where `kind == 'event_list_update'` | `agent` on the `claude` connector, few tool calls, only `data/events.yaml` in scope, build gate; `blocked` → emit `site.change_blocked` | small loop |
| 3b | `reply_blocked` | `site.change_blocked` | `connector` email.send: tells the editor what is missing | no |
| 4 | `update_site_general` | `email.classified` where `kind == 'general_change'` | `agent` on the same connector, more tool calls, full repo, build gate; `done` → `site.change_ready`, then `wait` for chat approval; `blocked` → `site.change_blocked` | bigger loop |
| 5 | `publish_site` | `task.update_event_list.succeeded` or `task.approve_general_change.succeeded` | `shell` lftp mirror | no |
| 6 | `notify` | `task.*.failed`, `task.publish_site.succeeded` | `connector` chat.send | no |

Everything that can be a filter is a filter (step 2's sender check). Steps 3 and 4 are the
same action kind; only the config differs. The agent's outcome is routed like any other
result: `done` continues to gates and publishing, `blocked` becomes an email back to the
sender with what is missing, a failure (refusal, over budget, no RESULT.json) reaches
`notify` through `task.*.failed`.

## 9. Cost control

- **Tiering is config, not code.** `model`, `effort`, `max_tokens`, `max_tool_calls`,
  `budget.max_usd` per task; defaults in `agent.yaml`.
- **Before building a model cascade, measure the top model at low effort** on the same
  task set. On the current generation, lower effort on a stronger model often beats a
  weaker model at high effort, and one model means one prompt-cache namespace.
- **Prompt caching by construction:** `system_file` is static and rendered first; the
  event payload is last. The ledger reports `cache_read_input_tokens` per task so a
  silently-invalidated cache is visible.
- **Dedup and filters** guarantee a model call is made at most once per real-world event.
- **Batch API** for anything that can wait (`batch: true`) — planned.
- **Classification is cheaper than generation.** A `decide` task (§5.3) answers typed
  questions with probabilities at a fraction of an `llm` call's price and latency; use it
  wherever the step needs a label, a yes/no or a level and no text.
- **Prices are config, never guessed.** A built-in USD-per-Mtok table covers the Claude
  models, the current OpenAI models and Jev; `pricing:` in `agent.yaml` overrides or
  extends it. A task whose model has no price fails validation unless its provider
  reports the cost per response (OpenRouter).
  A response that arrives unpriced anyway is recorded at $0 with `priced_by: unpriced`
  and fails the run, so it is noticed. An `agent` turn is ledgered from what the ACP
  agent reports (`usage_update.cost`, else tokens at the table price of `model`), under
  the connector's name as `provider`; the cap is enforced by cancelling the session.
- **Circuit breakers.** Per run: `budget.max_usd` (the smaller of the task's and the
  action's). Before the call the worst case (input at 3 chars/token plus `max_tokens` of
  output, at table prices; for `decide` the JSON body at input price and no output) must
  fit; after it the actual cost must, else the run fails
  non-retryably with the row kept. Globally: `budgets.daily_usd` per UTC day, derived
  from the ledger so a restart changes nothing. The call that crosses the cap still
  returns its result; from then until 00:00 UTC every model call fails fast without
  contacting a provider (`task.<name>.failed` fires as usual, the trigger event stays
  replayable with `oa run --event`). Crossing it emits `budget.exceeded` once per day
  (`dedup_key: budget:daily:<YYYY-MM-DD>`, payload `{scope, day, limit_usd, spent_usd,
  task, run_id}`), which `notify` picks up. A per-run overrun is an ordinary run
  failure.
- **Ledger** table: `run_id, task, provider, model, in_tok, out_tok, cache_read,
  cache_write, usd, priced_by, ts`. `oa cost --by task|model|provider|day --since 7d`,
  `GET /v1/cost`.

## 10. Reliability

- **Durability:** events and runs are committed to SQLite before anything acts on them.
  On startup, runs left in `running` are re-queued when `retry.attempts` allows another
  attempt (continuing from a sequence's last wait checkpoint if any), otherwise failed as
  interrupted; `waiting` runs stay waiting, and those whose wait already ended resume.
- **Dispatch:** one transaction per batch: read events past the cursor, insert `queued` runs,
  advance the cursor. `UNIQUE(task, event_id)` makes a replay after a crash a no-op: one run per
  (task, event); retries are attempts of the same run. The dispatcher always queues;
  `concurrency` is enforced by the executor.
- **Delivery:** at-least-once dispatch + `dedup_key` on events + idempotent actions
  (agent worktree per run, `publish` is a mirror, not an incremental push).
- **Retries:** per-task policy (`retry: {attempts, backoff: fixed|exponential, base, max}`,
  default from `defaults.retry`) with backoff; attempts belong to the same run, the run
  stays `running` between them with the last error recorded, and `task.<name>.failed`
  fires once after the last attempt. Timeouts and connector-down errors are retried;
  wait timeouts, missing secrets, unknown connectors, `isError` op results and unrenderable
  `emit` rules are not. `agent` actions retry in a fresh workspace (the previous one is
  removed with the failed attempt); appending the previous failure to the prompt is
  planned.
- **Timeouts:** every action has one, per attempt of active work (a `waiting` run holds no
  timer); an `agent` attempt is bounded by the wall clock (the session is cancelled on
  timeout) and by `max_tool_calls`.
- **Concurrency:** `concurrency: 1` default for agent tasks touching the same repo; global
  worker cap.
- **Poison events:** after `retry.attempts`, the run is `failed`, `task.<name>.failed`
  fires, and the event is not redelivered.

## 11. Security

**Trust model.** The daemon's uid is the trust boundary. Core and connectors share it, so
they can read each other's environment (`/proc/<pid>/environ`) and the socket API has no
authentication of its own: a process running as `247-agent` is trusted by definition.
Everything that executes content the daemon did not write, an `agent` action or a `shell`
action marked untrusted, therefore must not run as that uid: it runs under a separate
user or in a sandbox that unshares the pid namespace and does not mount the socket
directory. Moving secrets from the environment to a file or a pipe would not change
this; only the uid split does. Connector secrets stay in the connector's environment,
scoped to the names its manifest uses, and never in a pull endpoint that any local
process could call.

- Core and connectors run as an unprivileged `247-agent` user; systemd hardening
  (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`).
- Secrets via `LoadCredential=` (systemd) resolved by name in config; never written to
  the DB or run logs; injected only into the actions that declare them. The `file`
  backend refuses a secrets file readable by group or others.
- **Agent sandbox:** dedicated worktree, explicit tool-kind allowlist, command allowlist
  and workspace-bound paths, judged per call through ACP permission requests (§5.4), no
  deploy credentials. Build gate + commit before anything leaves the worktree. The policy
  only binds an agent that asks before acting; the agent *program* is confined by
  `sandbox: bwrap` on its manifest (§6): same uid, but its own pid namespace, no socket
  directory, no state or config directory, no daemon environment, `work_dir` and the
  listed repositories the only paths it can touch. That is the sandbox this section asks
  for; a separate uid would add nothing the daemon can enforce without privileges. The
  network stays open to the agent (it needs its model API); a network allowlist is
  planned and would take a filtering proxy.
- **Approval gate** (`wait` + chat) is config, so it can be required for high-impact tasks
  and skipped for routine ones.
- Inbound content (emails, chat, PR text) is untrusted: it enters prompts as data in a
  delimited block, and the agent's capability surface, not its prompt, is what limits
  damage.

## 12. Deployment on Linux

```ini
# /etc/systemd/system/247-agent.service
[Service]
User=247-agent
ExecStart=/opt/247-agent/bin/247-agent-core --config /etc/247-agent/agent.yaml
Restart=always
RestartSec=5
LoadCredential=anthropic_api_key:/etc/credstore/anthropic_api_key
LoadCredential=imap_pass:/etc/credstore/imap_pass
LoadCredential=ftp_pass:/etc/credstore/ftp_pass
RuntimeDirectory=247-agent
StateDirectory=247-agent
ProtectSystem=strict
NoNewPrivileges=yes
```

`sandbox: bwrap` (§5.1 for shell steps, §6 for agent programs) needs the `bubblewrap`
package (the `.deb`/`.rpm` recommend it) and unprivileged user namespaces
(`sysctl kernel.unprivileged_userns_clone=1` on Debian, the default elsewhere); a setuid
`bwrap` does not work under `NoNewPrivileges=yes`. Do not set `RestrictNamespaces=` on
the unit. Paths a sandboxed step or agent writes to still need `ReadWritePaths=` here,
since the sandbox lives inside the unit's own mount namespace (`work_dir` under
`/var/lib/247-agent` is covered by the shipped unit).

`/opt/247-agent` is the unpacked release tarball (`scripts/build-release.sh`): `bin/`
launchers, one bundled `.mjs` per program under `lib/`, a vendored Node under `node/`,
`better-sqlite3` with the target's prebuilt addon under `node_modules/`, docs, examples,
skills and this unit under `share/`. The tree is relocatable: the daemon resolves its
install root (`$OA_HOME`, else the nearest ancestor of its script with
`bin/247-agent-core`) and puts `<root>/bin` and its own Node first on `PATH` for every
child, which is how a manifest's `exec: ["247-agent-connector-email"]` finds the bundled
connector wherever the tree lives. A source checkout has the same `bin/` (running the
workspace `dist/`), so manifests are identical in development and production.
`scripts/install.sh` (shipped as `share/install.sh` and attached to every release)
installs or upgrades from the GitHub release: `/opt/247-agent-<version>` per version,
`/opt/247-agent` a symlink, the user, a starter `/etc/247-agent`, the unit; the new
version validates the existing config before the symlink moves. `uninstall.sh` is its
counterpart and keeps config, state and the user unless `--purge`. The `.deb` and
`.rpm` (`packaging/nfpm.yaml`, built by `scripts/build-package.sh` from the same tree
with nfpm) install the identical layout, `/usr/bin/oa`, the unit under
`/usr/lib/systemd/system` and the starter `/etc/247-agent` as conffiles; the maintainer
scripts (`packaging/scripts/`) create the user, enable and start on install, restart on
upgrade, stop on removal and clean up on purge. Both are attached to every release.

`247-agent-core` loads `agent.yaml`, opens the store, dispatches the backlog, arms cron,
then binds the socket; SIGHUP (or `oa reload`) re-reads agent.yaml, the manifests and the
tasks files (§4, Config loader), SIGTERM/SIGINT stop it (runs in flight are aborted and
recovered as interrupted on the next start). Logs go to journald as structured JSON
(`run_id`, `task`, `correlation_id` on every line). Prometheus `/metrics` on the socket
(Prometheus cannot scrape a Unix socket itself: `oa metrics` into a node_exporter
textfile on a timer, or a small HTTP proxy in front of the socket). CLI (`--socket`, else
`$OA_CORE_SOCKET`, else the path above):

```
oa validate <file>...           # tasks files and agent.yaml, schema + semantic checks
oa run <task> [--event f.json]  # manual trigger; --wait blocks and exits 1 on failure
oa emit <type> [payload.json|-] # inject an event (--source, --dedup-key, --parent)
oa runs ls [--status s] [--task t] [-n N]   # newest runs: id, task, status, created, duration, error
oa runs show <id>               # the run, its trigger event, ledger rows, result or error
oa runs logs <id> [--follow]    # the agent transcript (§5.4); --follow while the run is active
oa events tail [--type t] [-n N] [--follow]   # newest events in order; --type takes a trigger pattern
oa events show <id>
oa connector list|restart <name>
oa cost --by task --since 7d
oa reload                       # like SIGHUP; exits 1 and prints the issues when refused
oa metrics                      # GET /metrics
```

## 13. Repository layout

```
package.json                 # workspaces: packages/*, connectors/*
bin/                         # launchers: 247-agent-core, oa, 247-agent-connector-<name>; the same files in a checkout and a release
scripts/                     # bundle.mjs (esbuild, one .mjs per program), build-release.sh (the tarball), build-package.sh (.deb/.rpm), install.sh + uninstall.sh
packaging/                   # 247-agent.service, etc/ (the starter config), nfpm.yaml + scripts/ (the .deb/.rpm)
.github/workflows/           # ci (build, lint, test, tarball smoke), release (tarballs on v* tags)
packages/core/           # the daemon: config, store, scheduler, matcher, executor, api
  src/config/                # zod schemas for agent.yaml (incl. retention.ts), tasks, connectors; loader
  metrics.ts, retention.ts   # the Prometheus registry and the daemon's metrics; the retention pass (store/retention.ts does the SQL)
  src/store/                 # better-sqlite3: events, runs, state, ledger; migrations
  src/bus/                   # publish, matcher, dispatch loop, manual runs
  src/scheduler/             # croner jobs → cron.tick events
  src/actions/               # shell.ts, connector.ts, wait.ts, sequence.ts, llm.ts, decide.ts, agent.ts (+ agent-policy.ts, agent-workspace.ts, agent-result.ts, agent-config.ts); types.ts = ActionContext
  src/llm/                   # config.ts (providers, pricing, budgets), pricing.ts, service.ts (the ctx.llm port: budgets + ledger for `call` and `decide`), types.ts (provider interface), adapters per provider type (openrouter.ts also serves the Decisions API)
  src/executor/              # worker pool: concurrency, timeouts, retries, secrets, emit/state routing, wait suspend/resume, recovery
  src/connectors/            # supervisor.ts: spawn, MCP client per connector, ACP connection per agent, restart backoff; acp.ts: the ACP client (the only SDK import), acp-types.ts: the runner-facing session types; poller.ts: the built-in poller
  src/secrets/               # env | file | systemd-credentials backends
  src/api/                   # routes.ts (transport-free handlers), server.ts (node:http on the socket), client.ts (typed client for the CLI and TS connectors)
  daemon.ts, main.ts         # agent.yaml → core → api; the `247-agent-core` binary with signal handling
  home.ts, version.ts        # install root discovery + PATH for children; the version constant (`--version`)
  src/expr/                  # type globs, jmespath filters, ${…} templating
  ids.ts, log.ts, clock.ts   # ULID-style ids, JSON-lines logger, injectable clock
  test/fixtures/             # fake connectors (email, ftp, chat, generic MCP, plain) and a fake ACP agent (fake-acp.ts, scripted by prompt markers) run by Node from source
packages/cli/            # `oa` (node:util parseArgs); talks to the socket
packages/connector-sdk/  # helpers for TS connectors: connectorEnv(), CoreClient, defineTool/createConnectorServer/serveStdio, runConnector()
connectors/email/        # imapflow (IMAP) + own POP3 client + nodemailer (SMTP) + mailparser
connectors/ftp/          # ssh2-sftp-client (SFTP) + basic-ftp (FTP/FTPS), paths confined to a root
connectors/chat/         # Telegram Bot API over fetch (long polling), offset and pending questions in state
docs/                        # ARCHITECTURE.md, examples/
```

Runtime notes

- One Node process for the core; `worker_threads` are unnecessary because actions are
  I/O-bound (subprocesses, HTTP). Concurrency limits are enforced with a small semaphore
  per task and globally.
- `better-sqlite3` is synchronous by design; all DB work is short transactions on the
  main thread, which is fine at this scale and removes a class of async bugs.
- `agent` runtime: the runner (`actions/agent.ts`) creates the workspace, asks the
  supervisor (`ctx.agents`, the `AgentClients` port) for a session on the acp connector,
  drives one prompt turn as an async iterator of normalised updates, answers permission
  requests with `agent-policy.ts`, ledgers the turn through `ctx.llm.record`, reads
  RESULT.json (`agent-result.ts`, zod's `fromJSONSchema` for `result.schema`) and runs the
  gates through the `shell` runner. `connectors/acp.ts` owns the SDK: `execa` + `ndJsonStream`
  + `client().connect()`, `initialize` at spawn, `buildSession().start()` per run,
  `session/cancel` on demand.
- `llm` runtime: the runner resolves defaults, reads `system_file`, renders `input` and
  calls `ctx.llm`; the service (`src/llm/service.ts`) does budgets, secret resolution,
  the adapter call and the ledger row. Adapters receive the JSON Schema as is
  (`output_config.format` on Anthropic, `json_schema` formats elsewhere).
- `decide` runtime: the runner resolves `defaults.decide`, renders `state`, calls
  `ctx.llm.decide()` and checks the answers against the questions; the service shares
  the budget/ledger path with `call` and dispatches to the adapter's optional `decide`
  method, which only `openrouter.ts` implements (a plain `fetch` to the Decisions API).
- Distributed as one self-contained tarball per target (§12): esbuild bundles each
  program to a single ESM file (`better-sqlite3` stays outside for its native addon), a
  pinned Node (`.node-version`) is vendored, and `packages/core/src/version.ts` carries
  the version (checked against `package.json` by a test; release tags are `v<version>`).

## 14. Implementation order

1. Core skeleton: config loader, SQLite schema, event store, matcher, executor, `shell`
   action, `cron` + `event` triggers, CLI. (Everything already works for non-LLM automation.)
2. `connector` action + supervisor + `poller` built-in + `email` connector.
3. `llm` action with structured outputs, cost ledger, budgets, caching — in three
   stages: (a) ledger, budgets, provider config and the runner behind the `ctx.llm` port;
   (b) the Anthropic adapter; (c) OpenAI and OpenRouter adapters.
4. `agent` action over ACP with worktree workspace, permission policy, result contract, post gates.
5. `wait` action + `chat` connector (approval loop).
6. Hardening: retention GC, metrics, sandbox wrapper, hot reload.

Status: steps 1, 2 and 5 are done: `shell`, `connector`,
`wait` and `sequence` actions, `${…}` templating, `emit` routing, the state KV with
`/v1/state`, secrets backends, `retry` with recovery by policy, the connector supervisor,
the built-in `poller`, `tasks.d`/`connectors.d` merging, the connector SDK, the `email`,
`ftp` and `chat` (Telegram) connectors, and an integration test that runs the non-LLM path
of the website workflow on a real daemon with fake connectors. Step 3(a) is done: the `llm` action is fully
validated and runnable through `ctx.llm`, the cost ledger, `budget.max_usd`,
`budgets.daily_usd` and `budget.exceeded` work, `providers:`/`pricing:` are
cross-checked, `oa cost` and `GET /v1/cost` exist. Steps 3(b) and 3(c) are done: the
`anthropic`, `openai` and `openrouter` adapters (`packages/core/src/llm/anthropic.ts`,
`openai.ts`, `openrouter.ts`). The `decide` action (§5.3) is done: `actions/decide.ts`,
`ctx.llm.decide()` in the service, the Decisions API in the OpenRouter adapter,
`defaults.decide`, the provider-type cross-check and `docs/examples/decide-triage.yaml`.
Step 4 is done over ACP (§5.4): `transport: acp` manifests, the ACP client
(`connectors/acp.ts`), the `agent` runner with workspace, policy, tool-call and budget
cancellation, the ledger's `checkBudget`/`record`, the RESULT.json contract, post gates,
`defaults.agent`, the cross-checks, `docs/examples/connectors.d/claude.yaml` and the
`blocked` routing in the reference workflow; tested against a fake ACP agent.
Step 6 is done: the retention pass (`retention.ts`,
`store/retention.ts`, the workspace sweep in `actions/agent-workspace.ts`), `/metrics`
(`metrics.ts`, counters recorded in the bus, dispatcher, executor, scheduler, llm service
and supervisor, gauges collected at scrape time in `core.ts`), connector health checks in
the supervisor, the full reload (`Core.reload`, `Daemon.reload`, `POST /v1/reload`,
`oa reload`), and the sandbox wrapper for agent programs (`sandbox:` on `acp`
manifests, `actions/sandbox.ts` + the supervisor, the `checkSandboxes` cross-check).
Where the code is behind this document:
`batch: true` is rejected; `mcp_servers` on an `agent` action must be empty (the MCP
proxy is not built); the agent sandbox has no network allowlist; ACP config options
(model, mode) are not exposed; `shell.user` is rejected.

## 15. Open decisions

- Expression language: JMESPath (simple, ubiquitous) vs CEL (richer, typed). Start with
  JMESPath; the matcher is one function to swap.
- Chat backend: Telegram is the least friction for a single user; Matrix if self-hosting
  matters.
- Whether `general_change` needs approval by default. The config supports both; start
  with approval on.
- Whether `decide` should also reach TypeSafe directly (a `typesafe` provider type
  against their own endpoint) rather than only through OpenRouter. Start with OpenRouter:
  one key, one ledger price source, and the wire protocol is the same.
