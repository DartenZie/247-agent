# Architecture

What the daemon is, the loop it runs, the components that run it and the invariants
each one keeps. Open this before touching the dispatch loop, the run lifecycle,
durability, or when you need the module map. The reasons behind the choices are in
[`decisions.md`](decisions.md).

## Goals and non-goals

- Everything is a task in a config file: one trigger, one action, routing of the result.
  A workflow is added without code.
- Deterministic work never touches a model. Filtering, deduplication, routing, retries
  and publishing are code; a model runs only inside `llm`, `decide` and `agent`
  actions, each with a model, effort, turn and dollar budget.
- Connectors plug into the core through one interface, in any language.
- Durable and observable: every event and run is persisted before anything acts on it;
  a crash never loses an email and never re-runs a finished job.
- Not a workflow engine with a UI, and not multi-node: one server, one process, one
  SQLite file.

## The loop

```
Connector ──emits──▶ Event ──matches──▶ Trigger ──starts──▶ Run(Task) ──result──▶ Event(s)
   ▲                                                            │
   └──────────────── ops (MCP tool calls) ◀──────────────────────┘
```

An **event** is the only thing that flows. The record (`store/types.ts`, `EventRecord`)
is `seq` (the dispatch order, an autoincrement), `id`, `type`, `source`, `ts`,
`correlation_id`, `parent_id`, `dedup_key`, `depth` and `payload`. Ids are ULID-style
(`ids.ts`): a prefix, 10 time characters and 16 random ones, `evt_…`, `run_…`, `cor_…`;
only `seq` orders events reliably.

- `correlation_id` threads one real-world happening through every run it causes:
  given, else inherited from the parent, else fresh (`bus/publish.ts`).
- `dedup_key` makes delivery idempotent: `UNIQUE(dedup_key)` and `ON CONFLICT DO
  NOTHING` turn a repeat into `{status: 'duplicate'}`.
- `source` is `scheduler` (cron ticks), `manual` (`oa run`), `api` (the default of
  `POST /v1/events`), `core` (`budget.exceeded`, `llm.batch.ended`), a connector's or a
  poller's manifest name, or `task:<name>` for everything a task's runs publish.
- `depth` is the hop count through `parent_id`; roots are 0.

A **task** matches events through its trigger (`bus/matcher.ts`): a cron task matches
`cron.tick` with its name in the payload, an event task matches `type`/`type_any`
patterns and then its JMESPath `filter`, a manual task matches nothing. Every task
matches a `manual.run` naming it, filter and overlap aside. A task never matches an
event whose source is its own `task:<name>`, which is how `task.*.failed` listeners
cannot loop. Each matching event starts exactly one **run**; retries are attempts of
that run.

## Components

One process, `247-agent-core` (`main.ts` → `daemon.ts` → `core.ts`). Each component
reads its settings through a `configure()` seam so a reload applies them live
([`config.md`](config.md)).

| Component | Where | Responsibility | Invariant |
|---|---|---|---|
| Config loader | `config/` | Reads `agent.yaml`, the tasks files and the manifests, validates and cross-checks them, applies them all or nothing on SIGHUP or `POST /v1/reload` | An invalid file on reload changes nothing; `db`, `socket`, `secrets` are fixed for the process |
| Scheduler | `scheduler/cron.ts` | One croner job per cron task and poller; each tick publishes `cron.tick` with `dedup_key: cron:<task>:<boundary>` | Missed ticks are never replayed; a duplicate boundary is dropped by the key |
| Event store and bus | `store/events.ts`, `bus/publish.ts`, `bus/bus.ts` | Append-only `events`; publish validates the type (no wildcards) and the parent, assigns ids and depth, inserts in `BEGIN IMMEDIATE`, wakes the dispatcher | An event is committed before anything acts on it |
| Dispatcher | `bus/dispatcher.ts` | Reads events past the `dispatch` cursor, ends waits, drops too-deep events, matches tasks, inserts `queued` runs, advances the cursor, all in one transaction per batch | `UNIQUE(task, event_id)` makes a replay after a crash a no-op |
| Matcher | `bus/matcher.ts` | Trigger matching and the labelled event-type set for metrics | A throwing filter is a non-match (`trigger.filter_error`) |
| Executor | `executor/executor.ts` | Worker pool: global `workers` and per-task `concurrency`, per-attempt timeout, retries with backoff, secret resolution, the runner call, `emit` and `state_updates` in one transaction with the terminal status, wait suspend and resume, recovery at start | A run's terminal status, its state updates and its emitted events commit together; a render failure after success fails the run and emits nothing |
| Action runners | `actions/*.ts` | One file per kind; `core.ts` `defaultRunners` maps `kind` to runner | A runner reaches the world only through `ActionContext` ([`actions.md`](actions.md)) |
| State KV | `store/state.ts` | `state(namespace, key, value)` for tasks (`${state.<ns>.<key>}`, `state_updates`) and connectors (`/v1/state`) | Tasks see a snapshot taken at run start |
| LLM port and ledger | `llm/service.ts`, `store/ledger.ts` | Prices, budgets and ledgers every model call; the daily breaker | No model call outside the port ([`model-actions.md`](model-actions.md)) |
| Batch poller | `llm/batches.ts` | Settles Message Batches in flight and publishes `llm.batch.ended` | A batch is settled whatever the run did |
| API | `api/server.ts`, `api/routes.ts` | `node:http` on the Unix socket, JSON in and out, `/metrics` as text | No authentication: the socket's mode (`0660`) and the daemon's uid are the boundary ([`security.md`](security.md)) |
| Connector supervisor | `connectors/supervisor.ts` | Spawns connectors, holds one MCP client per `stdio` connector and one ACP connection per agent, restarts with backoff, pings health, serves `oa connector restart` and reload | Connector secrets are rendered at spawn and nowhere else ([`connectors.md`](connectors.md)) |
| Retention | `retention.ts`, `store/retention.ts` | Deletes finished runs, ledger rows, dispatched events and workspaces past their durations | Active runs and anything they reference are never touched ([`store.md`](store.md)) |
| Metrics | `metrics.ts` | One registry; counters where things happen, gauges collected at scrape | Labels are bounded: task, connector, model, status, never an id |

## Dispatch

`Dispatcher.dispatchOnce()` runs one `BEGIN IMMEDIATE` transaction per batch of 100
events after the `dispatch` cursor:

1. Expire waits whose `expires_at` has passed (`endWait('timeout')`).
2. Read the next batch of events.
3. For each event: end every pending wait whose type pattern matches and whose filter
   is truthy (`endWait('matched', event)`); if `depth > limits.max_event_depth`
   (default 32) count it dropped, log `event.depth_exceeded` and start no run; else
   match tasks; for a `cron.tick` with `overlap: skip`, skip while the task has a run
   in `queued`, `running` or `waiting` (`cron.skipped_overlap`); insert a `queued` run
   with `INSERT OR IGNORE` on `UNIQUE(task, event_id)`.
4. Advance the cursor to the last `seq`, commit, hand the new runs to the executor.

`drain()` repeats until a batch is short. Every inserted event calls `wake()`, which
coalesces into one `setImmediate` drain; a 1 s timer is the safety net, so a wait
timeout is noticed within a second. A `manual.run` is drained synchronously inside the
API call, so `POST /v1/runs` returns the queued run.

Depth guard: too-deep events still end waits (a resume is not a new hop) but start no
run. Depth grows only through `parent_id`: lifecycle and `emit` events are parented to
their trigger, `llm.batch.ended` to the run's trigger; `cron.tick`, `manual.run`,
`budget.exceeded`, poller and API events without a parent are roots.

## Waits

A runner parks a run with `ctx.suspend(spec, resume)` (`executor.ts`): in one
transaction a `waits` row is written (`type` pattern, rendered `filter`, `expires_at`,
`on_timeout`, the runner's private `resume` JSON) and the run goes `waiting`; then
events already dispatched since the run's trigger are checked (`seq > trigger.seq`
and `≤` the cursor), so a reply that raced the asking step is not lost. The worker
slot is freed and no timer runs. The dispatcher ends the wait (`waits.resolve` sets
`outcome` and `event_id` once), sets the run `queued` and hands it back; the runner
restarts with `ctx.resume = {resume, outcome, event?}` on the same attempt. The row is
deleted when the run finishes. A wait outlives restarts because it is a row.

## Runs, attempts, retries

Statuses: `queued` → `running` → (`waiting` → `queued` → `running`)* → `succeeded` or
`failed`. `cancelled` is in the schema and accepted as a filter, but no code path sets
it. `attempt` is 0 while queued; the first attempt is 1; a resume after a wait keeps the
attempt; a retry increments it.

Retry policy is `task.retry ?? defaults.retry` (`attempts` 1, `exponential`, `base`
30s, `max` 1h). A failed attempt retries when the error is retryable, `attempt <
attempts` and the executor is not stopping; the delay is `base` for `fixed` and
`min(base × 2^(attempt−1), max)` for `exponential`. Between attempts the run stays
`running` with the attempt's error; `task.<name>.failed` is published once, after the
last attempt, with `{run_id, task, error, attempt}`. Retryability is a flag on the
error (`actions/types.ts`, `NonRetryableError`, `isRetryable`); the inventory per
runner is in [`actions.md`](actions.md).

The per-attempt timeout (`task.timeout ?? defaults.timeout`, 15m) aborts the attempt's
signal; a `waiting` run holds no timer. The pool is `workers` (4) globally and
`concurrency` (1) per task; the dispatcher always queues, the executor enforces both.

## Durability and recovery

Events and runs are committed before they are acted on; dispatch is at-least-once,
and `dedup_key` plus `UNIQUE(task, event_id)` make it effectively once. On
`core.start()` (`core.ts`, `executor.start()` runs before the backlog drain):

1. Every `running` run whose task is still configured and whose `attempt <
   retry.attempts` is re-enqueued (`run.recovered`) and runs as the next attempt;
   otherwise it is failed with `interrupted: the daemon restarted while the run was in
   progress`, which publishes `task.<name>.failed`.
2. Every `waiting` run without a `waits` row is failed; one whose wait already resolved
   is set `queued` and enqueued; the rest keep waiting.
3. Every `queued` run is enqueued.

`executor.stop()` aborts in-flight runs with `RunStoppedError`; they stay `running` in
the store for the next start. A stop during a retry backoff abandons the run the same
way (`run.abandoned`). An `agent` run recovered this way starts in a fresh workspace.

## Module map

```
packages/core/src/
  main.ts            the 247-agent-core binary: flags, OA_HOME, signals (SIGHUP reload, SIGTERM/SIGINT stop)
  daemon.ts          agent.yaml → secrets backend → manifests → core → API; reload with FIXED_KEYS
  core.ts            wires everything, defaultRunners, start/stop/reload, scrape-time gauges
  config/            zod schemas (agent.ts, schema.ts, connector.ts, retention.ts), load.ts, validators.ts, crosscheck.ts, check.ts
  store/             better-sqlite3: db.ts, migrations.ts, events, runs, waits, state, ledger, transcripts, batches, cursors, retention.ts (the SQL)
  bus/               publish.ts, matcher.ts, dispatcher.ts, manual.ts, bus.ts
  scheduler/cron.ts  croner jobs → cron.tick
  executor/          executor.ts: the worker pool and run lifecycle
  actions/           one runner per kind, agent-*.ts helpers, sandbox.ts, sandbox-net.ts, types.ts (ActionContext, the ports)
  llm/               service.ts (the ctx.llm port), config.ts, pricing.ts, models.ts, batches.ts, errors.ts, one adapter per provider type
  connectors/        supervisor.ts, acp.ts, acp-types.ts, mcp-bridge.ts, net-proxy.ts, poller.ts, host.ts, socket-transport.ts, child-env.ts
  secrets/           env, file, systemd-credentials
  api/               routes.ts (transport-free handlers), server.ts, client.ts
  expr/              glob.ts (type patterns), jmespath.ts, template.ts
  metrics.ts, retention.ts, log.ts, ids.ts, clock.ts, home.ts, version.ts, host-main.ts
```

Ports between the parts, all on `ActionContext` (`actions/types.ts`):

- `ctx.llm` (`LlmPort`, `llm/types.ts`): `call`, `decide`, `checkBudget`, `record`,
  `submitBatch`, `batchResult`. The only way to a model.
- `ctx.agents` (`AgentClients`): `open` an ACP session on an `acp` connector;
  implemented by the supervisor.
- `ctx.connectors` (`ConnectorClients`): `call(connector, op, args)` through the
  supervisor's MCP client, with the manifest's `ops` applied.
- `ctx.suspend`, `ctx.resume`: the wait seam between a runner and the executor.
- `ctx.render`, `ctx.renderText`, `ctx.scope`, `ctx.state`, `ctx.secrets`: templating
  over `{event, result, state, secrets, env, run, item, steps}`.
- `ctx.transcripts`: where an agent run writes its transcript.

The store is reached only by the executor, the dispatcher, the LLM service, retention
and the API; runners never touch it. Everything is in-process and single-node on
purpose: the dispatch loop is the one seam to replace if a queue is ever needed.
