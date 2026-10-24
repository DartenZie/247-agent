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
  given, else inherited from the parent, else fresh (`bus/publish.ts`). An `emit` rule
  with `each` gives each item a fresh one ([`actions.md`](actions.md)).
- `dedup_key` makes delivery idempotent: `UNIQUE(dedup_key)` and `ON CONFLICT DO
  NOTHING` turn a repeat into `{status: 'duplicate'}`.
- `source` is `scheduler` (cron ticks), `manual` (`oa run`), `api` (the default of
  `POST /v1/events`), `core` (`budget.exceeded`, `llm.batch.ended`,
  `retention.workspace_kept`), a connector's or a poller's manifest name, or
  `task:<name>` for everything a task's runs publish.
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
| Dispatcher | `bus/dispatcher.ts` | Reads events past the `dispatch` cursor, ends waits, drops too-deep events and events of a chain past its run cap (publishing `loop.detected`), matches tasks, skips paused ones, inserts `queued` runs, advances the cursor, all in one transaction per batch | `UNIQUE(task, event_id)` makes a replay after a crash a no-op |
| Matcher | `bus/matcher.ts` | Trigger matching and the labelled event-type set for metrics | A throwing filter is a non-match (`trigger.filter_error`) |
| Executor | `executor/executor.ts` | Worker pool: global `workers` and per-task `concurrency`, per-attempt timeout, retries with backoff, secret resolution, the runner call, `emit` and `state_updates` in one transaction with the terminal status, wait suspend and resume, cancel, recovery at start | A run's terminal status, its state updates and its emitted events commit together; a render failure after success fails the run and emits nothing |
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
   (default 32) drop it (`drop('depth')`) and start no run; else
   match tasks; for a `cron.tick` with `overlap: skip`, skip while the task has a run
   in `queued`, `running` or `waiting` (`cron.skipped_overlap`); skip a task listed in
   `task_pauses` (`task.skipped_paused`), read once per batch; insert a `queued` run
   with `INSERT OR IGNORE` on `UNIQUE(task, event_id)`, unless the event's chain has
   started `limits.max_runs_per_chain` runs (default 1000), which drops the event
   (`drop('chain_runs')`) for every task left. A paused task still has its
   waits ended in the step before: a pause stops new runs, not runs in the chain.
4. Advance the cursor to the last `seq`, commit, hand the new runs to the executor.

`drain()` repeats until a batch is short. Every inserted event calls `wake()`, which
coalesces into one `setImmediate` drain; a 1 s timer is the safety net, so a wait
timeout is noticed within a second. A `manual.run` is drained synchronously inside the
API call, so `POST /v1/runs` returns the queued run.

A drain that throws is logged (`dispatch.failed`), counted
(`oa_dispatch_failures_total`) and kept by `Dispatcher.health()` until the next drain
succeeds (`dispatch.recovered`); the events wait past the cursor meanwhile.

Depth guard: too-deep events still end waits (a resume is not a new hop) but start no
run. Depth grows only through `parent_id`: lifecycle and `emit` events are parented to
their trigger, `llm.batch.ended` to the run's trigger; `cron.tick`, `manual.run`,
`budget.exceeded`, `retention.workspace_kept`, `loop.detected`, poller and API events
without a parent are roots.

Chain cap: a chain is a root event and everything descended from it through
`parent_id`. `publishEvent` stores each event's `root_id` (the parent's root, or its own
id for a root), so the chain survives an `each` item's new correlation id, which is why
the cap counts chains and not correlations: a fan-out loop doubles per hop across new
correlations and would reach `2^32` runs before the depth guard. The count is
`EventStore.countChainRuns` (runs joined to their trigger events on `events_root`), read
once per chain per batch and counted up in memory as runs are inserted; it ends waits
like the depth guard does. Events stored before `root_id` existed count as their own
roots, and the count includes a legacy root's own runs.

`drop(event, reason, root)` counts `oa_events_dropped_total{reason}`, logs
`event.depth_exceeded` or `event.chain_runs_exceeded`, and publishes `loop.detected`
through the bus's own `publish` (so it is counted and wakes the dispatcher) inside the
batch transaction, with `dedup_key: loop:<root>`: one per chain whatever the reason or
the number of drops. A bounded in-memory set of roots reported in committed batches skips
the publish for the later drops of a storm (a rolled-back batch adds none, so its replay
publishes again), so `oa_events_published_total` gets one attempt per chain; after
a restart the dedup key still holds. It is a root with a new correlation, so a notifier on it is never
inside the chain it reports.

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

A run's first attempt pins the task definition it starts with to `runs.config`; every
later attempt and every resume after a wait runs under that copy, also after a restart,
so a reload changes only runs not yet started and a saved step index always matches the
steps it was saved for. A run whose task a reload removed fails: as no longer
configured when it next runs, or as interrupted when a restart comes first. The pin is cleared when the run finishes.

Statuses: `queued` → `running` → (`waiting` → `queued` → `running`)* → `succeeded`,
`failed` or `cancelled`; any of the three active statuses can go straight to
`cancelled`. `attempt` is 0 while queued; the first attempt is 1; a resume after a wait
keeps the attempt; a retry increments it.

Retry policy is `task.retry ?? defaults.retry` (`attempts` 1, `exponential`, `base`
30s, `max` 1h). A failed attempt retries when the error is retryable, `attempt <
attempts` and the executor is not stopping; the delay is `base` for `fixed` and
`min(base × 2^(attempt−1), max)` for `exponential`. Between attempts the run stays
`running` with the attempt's error and keeps its task's `concurrency`, but gives up its
worker; when the delay is over it waits for a free worker ahead of queued runs; `task.<name>.failed` is published once, after the
last attempt, with `{run_id, task, error, attempt}`. Retryability is a flag on the
error (`actions/types.ts`, `NonRetryableError`, `isRetryable`); the inventory per
runner is in [`actions.md`](actions.md).

The per-attempt timeout (`task.timeout ?? defaults.timeout`, 15m) aborts the attempt's
signal; a `waiting` run holds no timer. The pool is `workers` (4) globally and
`concurrency` (1) per task; the dispatcher always queues, the executor enforces both.

## Cancel and pause

`Executor.cancel(id)` (`POST /v1/runs/{id}/cancel`) ends an active run as `cancelled`
through `finishCancelled`: in one transaction the `waits` row, progress and pinned config
go, the status is `cancelled` with `finished_at` and `error: cancelled on request`, and
`task.<name>.cancelled` is published with `{run_id, task, previous_status, attempt}`. No
`emit` rule and no `state_updates` apply. What it does first depends on where the run is:

- Not in `inFlight` (queued in the pool or not yet handed over, `waiting`, or left
  `running` by a stop): removed from `pending` and `known`, then finished at once.
- In `inFlight`: the slot's `stop` controller is aborted with `RunCancelledError`, the
  reason that tells it from `RunStoppedError`. `perform` returns `cancelled` for a runner
  that throws after it; a retry backoff's `sleep` or `workerFor` rejects and the run is
  finished there; a runner that parks in a wait after the abort has the wait it armed
  removed. A runner that returns a result despite the abort finishes as it finished.
  `cancel` awaits the slot's `settled` promise for up to 5 s; the API answers 202 with
  the run still `running` when the runner has not settled by then.

A cancelled run is terminal, so `hasActive` no longer counts it and the next cron tick of
an `overlap: skip` task starts a run. Recovery never sees it.

A pause (`bus/pause.ts`) is a `task_pauses` row. The dispatcher starts no run of a paused
task from any event, and `runTaskManually` throws `TaskPausedError` (409) before it
publishes `manual.run`, so a refused `oa run` leaves no event behind. Events skipped while
paused are not replayed on resume: the cursor has moved past them. Runs already queued,
running or waiting are untouched; `oa runs cancel` ends them.

## Durability and recovery

Events and runs are committed before they are acted on; dispatch is at-least-once,
and `dedup_key` plus `UNIQUE(task, event_id)` make it effectively once. On
`core.start()` (`core.ts`, `executor.start()` runs before the backlog drain):

1. Every `running` run whose task is still configured and whose `attempt <
   retry.attempts` (of its pinned definition) is re-enqueued (`run.recovered`) and runs as the next attempt;
   otherwise it is failed with `interrupted: the daemon restarted while the run was in
   progress`, which publishes `task.<name>.failed`.
2. Every `waiting` run without a `waits` row is failed; one whose wait already resolved
   is set `queued` and enqueued; the rest keep waiting.
3. Every `queued` run is enqueued.

`executor.stop()` stops taking runs (`pump` is a no-op, the `onQueued` subscription is
dropped, pending runs are forgotten and stay `queued`) and abandons runs in a retry
backoff at once. It then waits up to `shutdown.grace` (`executor.draining`) for the runs
in flight to settle, and aborts the rest with `RunStoppedError` (`run.abandoned`). An
aborted attempt is given back: the run stays `running` with `attempt − 1`, so step 1
above reruns that attempt instead of failing the run as interrupted (#39); a resumed
attempt resumes again because its resolved `waits` row is kept. A retryable failure
during the window keeps the run `running` with its error for step 1 to retry. A run
that parks in a wait during the window and is matched at once stays `queued` for the
next start instead of being re-enqueued, so `idle()` can resolve. A crash leaves the
attempt counted; the crash path in `main.ts` stops with `{ grace: false }`, which
aborts at once. `main.ts` exits 1 (`daemon.stop_timeout`) when a
stop outlasts the grace window by 10 s; the unit's `TimeoutStopSec=90` is the outer
bound. An `agent` run recovered this way starts in a fresh workspace.

## Health and liveness

`GET /v1/health` (`health.ts`) reports the worst of three checks. The dispatcher check
reads `Dispatcher.health()`; the database check commits one row (`Store.probeWrite`, the
`health` cursor) so a read-only file, a full disk or a stuck lock shows; the connectors
check reads the supervisor's states, with pollers and `external` connectors as up and
`starting` as neither. `failing` answers 503, `degraded` and `ok` 200; `oa health` exits 0
only on `ok`.

Liveness belongs to systemd. `main.ts` sends `READY=1` after `startDaemon` resolves (config
loaded, store open, socket bound), then `WATCHDOG=1` from a timer every third of
`WATCHDOG_USEC`, so a blocked event loop misses the deadline and systemd restarts the
process. A failing health check does not stop the pings: a restart does not mend a full
disk. `systemd.ts` removes `NOTIFY_SOCKET` and the watchdog variables from the process
environment before anything is spawned, so no task or connector can notify for the
daemon ([`packaging.md`](packaging.md) has the unit side).

## Module map

```
packages/core/src/
  main.ts            the 247-agent-core binary: flags, OA_HOME, signals (SIGHUP reload, SIGTERM/SIGINT stop), systemd notifications
  systemd.ts         sd_notify through systemd-notify: READY, WATCHDOG, STOPPING
  health.ts          the checks behind GET /v1/health and oa health
  daemon.ts          agent.yaml → secrets backend → manifests → core → API; reload with FIXED_KEYS
  core.ts            wires everything, defaultRunners, start/stop/reload, scrape-time gauges
  config/            zod schemas (agent.ts, schema.ts, connector.ts, retention.ts), load.ts, validators.ts, crosscheck.ts, check.ts, lint.ts, walk.ts
  store/             better-sqlite3: db.ts, migrations.ts, events, runs, waits, state, ledger, transcripts, batches, cursors, retention.ts (the SQL)
  bus/               publish.ts, matcher.ts, dispatcher.ts, manual.ts, bus.ts
  scheduler/cron.ts  croner jobs → cron.tick
  executor/          executor.ts: the worker pool and run lifecycle
  actions/           one runner per kind, agent-*.ts helpers, sandbox.ts, sandbox-net.ts, types.ts (ActionContext, the ports)
  llm/               service.ts (the ctx.llm port), config.ts, pricing.ts, models.ts, batches.ts, errors.ts, one adapter per provider type
  connectors/        supervisor.ts, acp.ts, acp-types.ts, mcp-bridge.ts, net-proxy.ts, poller.ts, host.ts, socket-transport.ts, stdio-transport.ts, child-env.ts
  secrets/           env, file, systemd-credentials
  api/               routes.ts (transport-free handlers), server.ts, client.ts
  expr/              glob.ts (type patterns), jmespath.ts, template.ts
  metrics.ts, retention.ts, log.ts, ids.ts, clock.ts, home.ts, version.ts, host-main.ts, process-group.ts
```

Ports between the parts, all on `ActionContext` (`actions/types.ts`):

- `ctx.llm` (`LlmPort`, `llm/types.ts`): `call`, `decide`, `checkBudget`, `record`,
  `submitBatch`, `batchResult`. The only way to a model.
- `ctx.agents` (`AgentClients`): `open` an ACP session on an `acp` connector;
  implemented by the supervisor.
- `ctx.connectors` (`ConnectorClients`): `call(connector, op, args)` through the
  supervisor's MCP client, with the manifest's `ops` applied.
- `ctx.suspend`, `ctx.resume`: the wait seam between a runner and the executor.
- `ctx.saveProgress`, `ctx.progress`: how far an attempt got, kept on the run so the
  next attempt skips finished work (a sequence's finished steps).
- `ctx.render`, `ctx.renderText`, `ctx.scope`, `ctx.state`, `ctx.secrets`: templating
  over `{event, result, state, secrets, env, run, item, steps}`.
- `ctx.transcripts`: where an agent run writes its transcript.

The store is reached only by the executor, the dispatcher, the LLM service, retention
and the API; runners never touch it. Everything is in-process and single-node on
purpose: the dispatch loop is the one seam to replace if a queue is ever needed.
