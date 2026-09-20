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
| Anthropic Managed Agents (scheduled deployments) | Solid option for the `agent` tier if you prefer Anthropic to host the sandbox. Rejected as the *core* because the FTP target, credentials and site checkout live on your server, and cost control wants local gating. Kept as an alternative `agent.runtime` (§5.3). |

**Decision:** build a small core (~2–3k lines) and reuse aggressively underneath it:

- **systemd** for process supervision, timers are *not* used (the core owns cron so it can
  emit events).
- **SQLite (WAL)** as event log, run history, KV state and cost ledger.
- **MCP (Model Context Protocol)** as the *operations* half of the connector interface.
  Existing MCP servers (GitHub, Jira, IMAP, filesystem…) become connectors for free.
- **Anthropic Messages API** with structured outputs for `llm` actions.
- **Claude Agent SDK** (or `claude -p` headless) as the agent loop for `agent` actions:
  file edit, bash, MCP, permissions, max-turns and prompt caching are already solved.
- **croner** (cron parsing/scheduling), **zod** (config schema + validation, and the
  same schemas feed `betaZodTool` / structured outputs), **jmespath** (expressions),
  **better-sqlite3** (synchronous SQLite, WAL), **@modelcontextprotocol/sdk** (MCP client
  for connector ops), **execa** (subprocesses).

Language: **TypeScript on Node.js 22 LTS** (decided). Reasons: `@anthropic-ai/sdk` and
`@anthropic-ai/claude-agent-sdk` are first-class here, the MCP reference SDK is TypeScript,
and `claude` itself is a Node program, so one runtime serves core, agent runtime and most
connectors. Connectors remain language-agnostic (§6).

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
| **Config loader** | Reads `agent.yaml` + `tasks.d/*.yaml` + `connectors.d/*.yaml`, validates against schema, hot-reloads on SIGHUP (running runs finish under the old config). An invalid file on reload is logged and the previous config stays active. |
| **Scheduler** | Cron → `cron.tick` events (with task name in payload). |
| **Event store / bus** | Append-only `events` table. Publishing = insert. Dispatch loop reads a cursor, matches triggers, enqueues runs, advances the cursor, all in one transaction. At-least-once + `dedup_key` + `UNIQUE(task, event_id)` = effectively once. A task never matches events whose `source` is its own `task:<name>`; events deeper than `limits.max_event_depth` are dropped. The same loop ends `wait`s: an event matching a waiting run's wait, or a wait past its timeout (checked on every dispatch, so within the 1s safety-net interval), re-queues the run. |
| **Matcher** | Evaluates `trigger.filter` (JMESPath) against the event. Filters are pure, cheap, and where most "is this relevant?" logic should live (sender address, label, repo name). A filter that throws at run time counts as no match and is logged. |
| **Executor** | Worker pool. Enforces per-task and global concurrency, timeouts, retries with backoff, budgets. Resolves the secrets a task names, delegates to an *action runner* per kind, then applies `state_updates` and `emit` in one transaction with the lifecycle event. |
| **State KV** | `state(namespace, key, value)` for connectors and tasks (IMAP cursor, last-seen PR number…). Tasks read it as `${state.<ns>.<key>}` (a snapshot taken at run start) and write it with `state_updates`; connectors use the API. |
| **Cost ledger** | Per run: model, input/output/cache tokens, USD. Per task and global daily caps → circuit breaker. |
| **API** | HTTP over a Unix socket (`/run/247-agent/core.sock`), plain `node:http`, JSON in and out: `GET /v1/health`, `POST /v1/events` (201 inserted / 200 duplicate), `GET /v1/events/{id}`, `POST /v1/runs` (manual run, 201), `GET /v1/runs?status=&task=&limit=` (newest first), `GET /v1/runs/{id}`, `GET /v1/state/{ns}` (list), `GET|PUT|DELETE /v1/state/{ns}/{key}` (`PUT` body `{value}`). Errors are `{error, issues?}` with 400/404/405/413. A stale socket file left by a dead daemon is replaced at start; a live one refuses the start. Also what the CLI talks to. |
| **Connector supervisor** | Spawns configured connectors as child processes, holds one MCP stdio client per connector, restarts crashed ones with exponential backoff (`restart.base` doubling up to `restart.max`, reset after 30s up), passes the socket path, name, rendered config and secrets via env. Deferring to systemd units is not implemented. |

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
  cmd: ["lftp", "-e", "mirror -R --delete site/ /public_html; quit", "sftp://${secrets.ftp_user}@ftp.example.cz"]
  cwd: ${state.site_worktree}
  env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
  stdin: ${event.payload}          # optional, JSON on stdin
  result: json_stdout | text_stdout | exit_code
```

Runs as the service user, with `timeout`, stdout/stderr captured into the run log.
`cmd`, `cwd` and `env` values render to strings, `stdin` to its raw value. Result is
parsed JSON from stdout when `result: json_stdout`. A `user:` override is not supported.

### 5.2 `llm` — single model call, structured output, no loop

```yaml
action:
  kind: llm
  model: claude-haiku-4-5          # cheapest tier that passes the eval for this task
  effort: low                      # Opus/Sonnet 5 only; ignored on Haiku 4.5
  max_tokens: 512
  system_file: prompts/classify_orchestra_email.md   # stable → prompt-cached
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

Implementation: `client.messages.parse()` / `output_config.format` with the schema; the
result is guaranteed to validate. System prompt first with a cache breakpoint, volatile
input last. Usage from `response.usage` goes to the ledger. Optional `batch: true` routes
non-urgent tasks through the Message Batches API at half price (results arrive async as
events, which the model of this system handles naturally).

### 5.3 `agent` — agentic loop with tools, sandboxed

```yaml
action:
  kind: agent
  runtime: claude-agent-sdk        # | claude-cli | managed-agents
  model: claude-sonnet-5
  effort: medium
  max_turns: 40
  budget: { max_usd: 1.50 }        # hard stop; run → failed, on_failure fires
  workspace:
    kind: git-worktree             # fresh worktree per run; discarded on failure
    repo: /var/lib/247-agent/repos/orchestra-site
    branch: main
  tools: [Read, Edit, Write, Glob, Grep, Bash]
  bash_allow: ["npm run build", "npm test", "git status", "git diff"]
  mcp_servers: [email]             # connectors exposed as tools (§6)
  system_file: prompts/agent_event_list.md
  prompt: |
    Add/modify the concert events described in the email below in data/events.yaml
    and nothing else. Run `npm run build` before finishing.

    ${event.payload.body}
  result:
    from: file                     # agent writes RESULT.json in the workspace
    path: RESULT.json
    schema: schemas/site_change.json
  post:                            # deterministic gates, no LLM
    - shell: ["npm", "run", "build"]
    - shell: ["git", "commit", "-am", "agent: ${result.summary}"]
```

Notes

- The **agent never publishes**. It edits a worktree, a build gate proves it didn't break
  anything, a commit records it, and a separate `shell` task ships it. Rollback is
  `git revert` + republish.
- The **agent never sees deploy credentials**. Secrets are injected only into the actions
  that need them.
- `tools` + `bash_allow` + `mcp_servers` is the entire capability surface. Two tasks
  with different intelligence needs are the same action kind with a different
  `model`/`effort`/`max_turns`/`system_file`.
- `runtime: claude-cli` runs `claude -p … --output-format json --max-turns N --allowedTools …`
  as a subprocess; `claude-agent-sdk` does the same in-process with hooks for per-tool
  approval/logging; `managed-agents` submits a session to Anthropic's hosted sandbox with
  the repo mounted and gets the diff back. Same config, swappable runtime.

### 5.4 `connector` — call one operation on a sub-program

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

### 5.5 `wait` — suspend the run until an event arrives (human in the loop)

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

### 5.6 `sequence` — a few steps in one run, without inventing events for each

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

### 5.7 Routing: `emit`

Every task emits `task.<name>.succeeded|failed` automatically. `emit` adds domain events,
including fan-out:

```yaml
emit:
  - type: email.received
    each: ${result.emails}         # one event per item
    dedup_key: "email:${item.message_id}"
    payload: ${item}
  - type: orchestra.classified
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
exec: ["node", "connectors/email/dist/main.js"]  # or any executable, any language
transport: stdio                                     # stdio = MCP server on stdin/stdout; none = emits only
emits: [email.received]                              # documented, shape-checked
ops: [fetch_new, mark_read, send]                    # allowlist of MCP tools the core may call; [] = any
config: { host: imap.example.cz, user: "${secrets.imap_user}", folder: INBOX }
restart: { base: 1s, max: 60s }                      # crash backoff
health: { interval: 60s }                            # accepted, not used yet
```

`config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only. `cwd` is
relative to the manifest. Manifests live in `connectors.d/*.yaml` or inline in the
`connectors:` list of `agent.yaml`; names must be unique.

**Events out (connector → core):** `POST http://unix:/run/247-agent/core.sock/v1/events`
with the Event JSON (core assigns `id`/`ts`, honours `dedup_key`). A one-line curl in
any language. Push-style connectors (chat bots, webhooks) use this; poll-style ones don't
need it at all (next point).

**Ops in (core → connector):** the connector is an **MCP server**. The core holds one
client connection; agent runs get the same server passed in their MCP config. So one
implementation of `email.send` serves both a deterministic task and an agent.

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
Stderr lines are logged as `connector.output`. A `247-agent-connector@name` systemd unit
for connectors that need their own privileges is not implemented yet.

**SDK (`@247-agent/connector-sdk`):** `connectorEnv()`, `CoreClient` (`emitEvent`,
`getState`/`putState` in the connector's own namespace), `defineTool` +
`createConnectorServer` + `serveStdio`, or `runConnector({tools, setup})` for all of it. The
module has no local imports so Node can run a connector straight from TypeScript source.

Planned connectors: `email` (IMAP/SMTP), `chat` (Telegram or Matrix; emits `chat.message`,
`chat.reply`; ops `send`, `ask`), `github`, `jira` (both thin wrappers or direct use of
their official MCP servers + `poller`), `webhook` (generic HTTP in), `poller` (built-in).

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
defaults:
  llm:   { model: claude-haiku-4-5, max_tokens: 1024 }
  agent: { model: claude-sonnet-5, effort: medium, max_turns: 30, budget: { max_usd: 1.0 } }
  retry: { attempts: 3, backoff: exponential, base: 30s }
budgets:
  daily_usd: 10          # global circuit breaker → all llm/agent tasks pause, alert emitted
retention: { events: 90d, runs: 90d, workspaces: 7d }
limits: { max_event_depth: 32 }   # drop events deeper than this in a causal chain (loop guard)
```

The whole `/etc/247-agent` tree is meant to live in a git repo; `oa validate` checks
it in CI. `oa validate` takes tasks files, connector manifests and `agent.yaml` files alike
(a file whose `tasks` is a list of tasks is a tasks file; one with `name` and `exec` is a
manifest) and follows `agent.yaml` to every tasks file and manifest it names, checking
task and connector names are unique across files. `docs/examples/agent.yaml` is the
reference.

## 8. Worked example: orchestra website

See `docs/examples/orchestra-website.yaml`. The flow and what each step costs:

| # | Task | Trigger | Action | LLM? |
|---|---|---|---|---|
| 1 | `fetch_email` | cron `*/2 * * * *` | `connector` email.fetch_new → emit `email.received` per mail | no |
| 2 | `classify_orchestra_email` | `email.received` with filter `payload.from == 'orchestrator@…'` | `llm` Haiku 4.5, schema `{kind, summary}` → emit `orchestra.classified` | 1 call |
| 3 | `update_event_list` | `orchestra.classified` where `kind == 'event_list_update'` | `agent` Sonnet 5, low turns, only `data/events.yaml` in scope, build gate | small loop |
| 4 | `update_site_general` | `orchestra.classified` where `kind == 'general_change'` | `agent` Opus 5, higher turns, full repo, build gate, then `wait` for chat approval | bigger loop |
| 5 | `publish_site` | `task.update_event_list.succeeded` or `task.update_site_general.succeeded` | `shell` lftp mirror | no |
| 6 | `notify` | `task.*.failed`, `task.publish_site.succeeded` | `connector` chat.send | no |

Everything that can be a filter is a filter (step 2's sender check). Steps 3 and 4 are the
same action kind; only the config differs.

## 9. Cost control

- **Tiering is config, not code.** `model`, `effort`, `max_turns`, `max_tokens`,
  `budget.max_usd` per task; defaults in `agent.yaml`.
- **Before building a model cascade, measure the top model at low effort** on the same
  task set. On the current generation, lower effort on a stronger model often beats a
  weaker model at high effort, and one model means one prompt-cache namespace.
- **Prompt caching by construction:** `system_file` is static and rendered first; the
  event payload is last. The ledger reports `cache_read_input_tokens` per task so a
  silently-invalidated cache is visible.
- **Dedup and filters** guarantee a model call is made at most once per real-world event.
- **Batch API** for anything that can wait (`batch: true`).
- **Circuit breakers:** per-task and global daily USD caps; exceeding one pauses the
  model-backed tasks and emits `budget.exceeded` (which `notify` picks up).
- **Ledger** table: `run_id, task, model, in_tok, out_tok, cache_read, cache_write, usd`.
  `oa cost --by task --since 7d`.

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
  `emit` rules are not. `agent` actions will retry with a fresh worktree and the previous
  failure appended to the prompt (once).
- **Timeouts:** every action has one, per attempt of active work (a `waiting` run holds no
  timer); agent timeouts are wall-clock plus `max_turns`.
- **Concurrency:** `concurrency: 1` default for agent tasks touching the same repo; global
  worker cap.
- **Poison events:** after `retry.attempts`, the run is `failed`, `task.<name>.failed`
  fires, and the event is not redelivered.

## 11. Security

- Core and connectors run as an unprivileged `247-agent` user; systemd hardening
  (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`).
- Secrets via `LoadCredential=` (systemd) resolved by name in config; never written to
  the DB or run logs; injected only into the actions that declare them.
- **Agent sandbox:** dedicated worktree, explicit tool allowlist, bash allowlist, no deploy
  credentials, optional `bwrap`/`firejail` wrapper, network restricted to allowed hosts.
  Build gate + commit before anything leaves the worktree.
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

`247-agent-core` loads `agent.yaml`, opens the store, dispatches the backlog, arms cron,
then binds the socket; SIGHUP re-reads the tasks file, SIGTERM/SIGINT stop it (runs in
flight are aborted and recovered as interrupted on the next start). Logs go to journald as
structured JSON (`run_id`, `task`, `correlation_id` on every line). Optional Prometheus
`/metrics` on the socket. CLI (`--socket`, else `$OA_CORE_SOCKET`, else the path above):

```
oa validate <file>...           # tasks files and agent.yaml, schema + semantic checks
oa run <task> [--event f.json]  # manual trigger; --wait blocks and exits 1 on failure
oa emit <type> [payload.json|-] # inject an event (--source, --dedup-key, --parent)
oa events tail [--type …]
oa runs ls|show <id>|logs <id>
oa cost --by task --since 7d
oa connectors status
```

## 13. Repository layout

```
package.json                 # workspaces: packages/*, connectors/*
packages/core/           # the daemon: config, store, scheduler, matcher, executor, api
  src/config/                # zod schemas for agent.yaml, tasks, connectors; loader + hot reload
  src/store/                 # better-sqlite3: events, runs, state, ledger; migrations
  src/bus/                   # publish, matcher, dispatch loop, manual runs
  src/scheduler/             # croner jobs → cron.tick events
  src/actions/               # shell.ts, connector.ts, wait.ts, sequence.ts (llm.ts, agent.ts to come); types.ts = ActionContext
  src/executor/              # worker pool: concurrency, timeouts, retries, secrets, emit/state routing, wait suspend/resume, recovery
  src/connectors/            # supervisor.ts: spawn, MCP client per connector, restart backoff; poller.ts: the built-in poller
  src/secrets/               # env | file | systemd-credentials backends
  src/api/                   # routes.ts (transport-free handlers), server.ts (node:http on the socket), client.ts (typed client for the CLI and TS connectors)
  daemon.ts, main.ts         # agent.yaml → core → api; the `247-agent-core` binary with signal handling
  src/expr/                  # type globs, jmespath filters, ${…} templating
  ids.ts, log.ts, clock.ts   # ULID-style ids, JSON-lines logger, injectable clock
  test/fixtures/             # fake connectors (email, chat, generic MCP, plain) run by Node from source
packages/cli/            # `oa` (node:util parseArgs); talks to the socket
packages/connector-sdk/  # helpers for TS connectors: connectorEnv(), CoreClient, defineTool/createConnectorServer/serveStdio, runConnector()
connectors/email/        # imapflow + nodemailer
connectors/chat/         # grammy (Telegram) or matrix-js-sdk
docs/                        # ARCHITECTURE.md, examples/
```

Runtime notes

- One Node process for the core; `worker_threads` are unnecessary because actions are
  I/O-bound (subprocesses, HTTP). Concurrency limits are enforced with a small semaphore
  per task and globally.
- `better-sqlite3` is synchronous by design; all DB work is short transactions on the
  main thread, which is fine at this scale and removes a class of async bugs.
- `agent` runtime uses `query()` from `@anthropic-ai/claude-agent-sdk` with `cwd` set to
  the worktree, `allowedTools`, `maxTurns`, `mcpServers`, `permissionMode`, and a
  `PreToolUse` hook that enforces `bash_allow` and logs every tool call to the run.
- `llm` runtime uses `client.messages.parse()` with a zod schema derived from
  `output_schema`; usage from the response goes straight to the ledger.
- Distributed as a single tarball plus `node_modules` (or bundled with `tsup`) under
  `/opt/247-agent`; systemd unit unchanged (§12).

## 14. Implementation order

1. Core skeleton: config loader, SQLite schema, event store, matcher, executor, `shell`
   action, `cron` + `event` triggers, CLI. (Everything already works for non-LLM automation.)
2. `connector` action + supervisor + `poller` built-in + `email` connector.
3. `llm` action with structured outputs, cost ledger, budgets, caching.
4. `agent` action on `claude-agent-sdk` with worktree workspace, post gates.
5. `wait` action + `chat` connector (approval loop).
6. Hardening: retention GC, metrics, sandbox wrapper, hot reload.

Status: steps 1, 2 (minus a real `email` connector) and 5 (minus a real `chat` connector)
are done: `shell`, `connector`, `wait` and `sequence` actions, `${…}` templating, `emit`
routing, the state KV with `/v1/state`, secrets backends, `retry` with recovery by policy,
the connector supervisor, the built-in `poller`, `tasks.d`/`connectors.d` merging, the
connector SDK, and an integration test that runs the non-LLM path of the orchestra workflow
on a real daemon with fake connectors. Where the code is behind this document: `llm` and
`agent` actions validate `kind` only and have no runner (a run of one fails with "no
runner"); `budgets`, `retention` and `defaults.llm|agent` validate but are not applied;
there is no cost ledger, no retention GC, no metrics, no sandbox wrapper;
`SIGHUP` reloads tasks files only (connector changes need a restart); `shell.user` is
rejected; `health.interval` in manifests is accepted but unused.

## 15. Open decisions

- Expression language: JMESPath (simple, ubiquitous) vs CEL (richer, typed). Start with
  JMESPath; the matcher is one function to swap.
- Chat backend: Telegram is the least friction for a single user; Matrix if self-hosting
  matters.
- Whether `general_change` needs approval by default. The config supports both; start
  with approval on.
