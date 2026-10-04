# The store

The SQLite database: how it is opened, every table, who writes what, and the retention
pass that keeps it bounded. Open this when touching `packages/core/src/store/`, a
migration, or retention.

## Opening

`store/db.ts` opens the file with `better-sqlite3` and sets `journal_mode = WAL`,
`synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`. Migrations
(`store/migrations.ts`) run in order and set `PRAGMA user_version` to the number applied;
six ship, so a current database reads `user_version = 6`. `store.transaction(fn)` is
`BEGIN IMMEDIATE`, which takes the write lock up front so a batch never deadlocks against
a reader that wants to write.

`better-sqlite3` is synchronous: every store call is a short transaction on the main
thread, there is no await between a read and the write that depends on it, and that is
what removes a class of races ([`decisions.md`](decisions.md)).

## Tables

**`events`**: `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `id TEXT UNIQUE`, `type`,
`source`, `ts`, `correlation_id`, `parent_id`, `dedup_key TEXT UNIQUE`, `depth INTEGER
DEFAULT 0`, `payload TEXT` (JSON). Indexes `events_type_seq(type, seq)`,
`events_correlation(correlation_id, seq)`. Written by `bus/publish.ts` only
(`INSERT … ON CONFLICT(dedup_key) DO NOTHING`). `seq` is the dispatch order and the
only reliable ordering; a SQL function `type_matches(pattern, type)` serves pattern
queries.

**`runs`**: `id TEXT PRIMARY KEY`, `task`, `event_id REFERENCES events(id)`,
`correlation_id`, `status` with a CHECK on the six statuses, `attempt INTEGER DEFAULT
0`, `created_at`, `started_at`, `finished_at`, `result TEXT` (JSON), `error TEXT`,
`UNIQUE (task, event_id)`. Indexes `runs_task_status(task, status)`,
`runs_status_created(status, created_at)`, `runs_event(event_id)`. Inserted by the
dispatcher as `queued`; status, attempt, timings, result and error written by the
executor.

**`cursors`**: `name TEXT PRIMARY KEY`, `seq INTEGER`; seeded with `('dispatch', 0)`.
The dispatcher's position.

**`state`**: `namespace`, `key`, `value TEXT` (JSON), `updated_at`, `PRIMARY KEY
(namespace, key)`. Written by the executor (`state_updates`, after a successful run),
by connectors and the API (`PUT /v1/state/<ns>/<key>`), and by pollers (`<name>/seen`).

**`waits`**: `run_id TEXT PRIMARY KEY REFERENCES runs(id)`, `task`, `type` (a pattern),
`filter` (rendered JMESPath or null), `expires_at`, `on_timeout` (`fail`|`succeed`),
`resume TEXT` (the runner's private JSON), `created_at`, `outcome` (`matched`|`timeout`|
null), `event_id`. Indexes `waits_type`, `waits_expires`, `waits_event`. One row per run;
a second insert replaces the first; written by the executor's `suspend`, resolved by the
dispatcher, deleted when the run finishes.

**`ledger`**: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `run_id REFERENCES runs(id)`,
`task`, `provider`, `model`, `in_tok`, `out_tok`, `cache_read DEFAULT 0`, `cache_write
DEFAULT 0`, `usd REAL`, `priced_by` with a CHECK on `table`|`provider`|`unpriced`,
`ts`. Indexes `ledger_ts`, `ledger_run`, `ledger_task_ts`. Written only by
`llm/service.ts` (`settle`), one row per model call, decision or agent turn. `GET
/v1/cost` and the daily cap are sums over it.

**`transcripts`**: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `run_id REFERENCES runs(id)`,
`ts`, `turn`, `kind` (`prompt`, `text`, `thought`, `tool_call`, `tool_call_update`,
`permission`, `usage`, `stop`, `cancel`, `result`), `text`, `data TEXT` (JSON). Index
`transcripts_run(run_id, id)`. Written by `actions/agent-transcript.ts` through
`ctx.transcripts`, with secrets redacted before the row exists.

**`llm_batches`**: `batch_id TEXT PRIMARY KEY`, `run_id`, `task`, `attempt`, `provider`,
`model`, `structured INTEGER`, `worst_usd REAL`, `submitted_at`. Index
`llm_batches_run(run_id)`. No foreign key to `runs` on purpose: a run with a batch in
flight is kept by retention instead, and a batch whose run is gone is still settled
(`llm.batch_orphaned`) so the provider's bill is accounted for.

## Ids

`ids.ts`: `<prefix>_` plus 26 Crockford base32 characters, 10 from a 48-bit millisecond
timestamp and 16 random. Prefixes `evt`, `run`, `cor`. Ordering holds only to the
millisecond; `seq` orders events, `id` orders ledger and transcript rows.

## Retention

Policy from `retention:` in `agent.yaml` (`config/retention.ts`): `events` 90d, `runs`
90d, `ledger` = `runs`, `workspaces` 7d, `interval` 1h; `never` keeps a kind forever;
`runs` and `ledger` are at least 1d because the daily cap sums today's ledger rows, and
`ledger` cannot outlive `runs` because a run's rows go with the run.

`retention.ts` runs a pass once at start and every `interval`, never overlapping. Each
step deletes in batches of 500 rows, one `BEGIN IMMEDIATE` transaction per batch with a
`setImmediate` yield between them (`store/retention.ts`), so a large purge never holds
the write lock for long. The order and the conditions:

1. **Runs** older than `runs` (`finished_at < cutoff`), in a terminal status, with no
   `llm_batches` row: for each batch, their `ledger` rows, their `transcripts`, their
   `waits` row, then the runs. Active runs are never selected.
2. **Ledger** rows older than `ledger` whose run is not `queued`, `running` or
   `waiting`.
3. **Events** already dispatched (`seq <=` the cursor), older than `events`, referenced
   by no `runs.event_id` and no `waits.event_id`. A kept run therefore keeps its
   trigger event whatever `events` says, and `dedup_key` uniqueness spans only the
   events still kept.
4. **Workspaces**: every `<work_dir>/run_*` directory whose run is unknown and whose
   mtime is past the cutoff, or whose run is terminal and finished past the cutoff
   (`actions/agent-workspace.ts`): a git worktree is removed with `worktree remove
   --force`, the directory deleted, `worktree prune` run and the `agent/<run_id>`
   branch deleted; git failures are ignored. Directories of active runs, and the
   program homes under `<work_dir>/home/`, are left alone.

Counts go to `retention.purged` (info when anything was deleted) and to
`oa_retention_deleted_total{kind}`; a throwing pass logs `retention.failed` and leaves
the rest for the next one.

## Rules a change must keep

- A schema change is a new migration appended to `migrations.ts`; existing ones are
  never edited. `user_version` moves with it.
- A new table that references runs either carries a foreign key to `runs(id)` and is
  deleted in step 1 before the runs, or is kept alive like `llm_batches` and documented
  here.
- The retention order stays dependency-first: children before parents, events last,
  and nothing that an active run or a pending wait references.
- Rows the daily cap needs (today's ledger) are never deletable: the 1d floor on `runs`
  and `ledger` is the guard.
- Every write that must be atomic with another goes through `store.transaction`; the
  executor's terminal transaction (status, `state_updates`, lifecycle event, emitted
  events, `waits` delete) is the model.
- Secrets never reach a row: values are resolved per run and redacted from transcripts;
  `state`, `events` and `runs.result` hold only what tasks and connectors put there.
