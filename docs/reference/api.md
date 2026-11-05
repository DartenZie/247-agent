# HTTP API reference

Every route the daemon serves on its Unix socket, with parameters, bodies and status
codes. This is what `oa` and the connectors use, and what you use for anything the CLI
does not cover.

## Transport

- HTTP/1.1 over the Unix socket named by `socket` in `agent.yaml`, default
  `/run/247-agent/core.sock`, created with mode `0660`. There is no authentication:
  anything that can open the socket is trusted.
- Requests and responses are JSON (`application/json; charset=utf-8`). A body larger
  than 1 MiB is read to the end and refused with 413
  `request body exceeds 1048576 bytes`. A non-empty body is parsed as JSON whatever its
  content type; invalid JSON is a 400.
- Errors are `{"error": "<message>", "issues"?: [{"path": "...", "message": "..."}]}`.
  `issues` appears on validation failures. Status codes used: 200, 201, 400, 404, 405,
  409, 413 and 500 (`{"error": "internal error"}` for an unexpected exception).
- A wrong method answers 405 with `method <M> not allowed; use <ALLOWED>`; an unknown
  path answers 404 with `no route for <METHOD> <path>`.
- Query parameters are strict: an unknown key or a bad value is 400 `invalid query`.

```sh
curl --unix-socket /run/247-agent/core.sock http://unix/v1/health
curl --unix-socket "$OA_CORE_SOCKET" 'http://unix/v1/runs?status=failed&limit=10'
curl --unix-socket "$OA_CORE_SOCKET" -X PUT http://unix/v1/state/email/last_uid \
  -H 'content-type: application/json' -d '{"value": 0}'
```

## Routes

### `GET /v1/health`

200 when `status` is `ok` or `degraded`, 503 when it is `failing`, with the same body:

```json
{ "ok": false, "status": "degraded", "pid": 4242, "started_at": "2026-10-04T08:00:00.000Z",
  "uptime_s": 3600, "config_file": "/etc/247-agent/agent.yaml", "tasks": 8,
  "runs": { "pending": 0, "in_flight": 1 },
  "checks": {
    "dispatcher": { "status": "ok", "error": null, "failing_since": null },
    "database": { "status": "ok", "error": null },
    "connectors": { "status": "degraded", "up": 2, "total": 3, "down": ["chat"] } } }
```

| Field | Meaning |
|---|---|
| `status` | the worst of the three checks: `ok`, `degraded` or `failing` |
| `ok` | `true` only when `status` is `ok` |
| `checks.dispatcher` | `failing` when the last pass that turns events into runs threw; `error` is its message and `failing_since` when the failures started. It is `ok` again after one pass succeeds |
| `checks.database` | `failing` when the daemon cannot commit a write to its database: the file is read-only, the disk is full, or a lock is held for more than 5 seconds |
| `checks.connectors` | `ok` when every connector is up; `degraded` when some are down, stopped, restarting, failing their `health:` pings or starting for the first time (`down` lists them by name, except those starting for the first time); `failing` when none is up and none is starting for the first time. Built-in pollers and connectors in their own unit without ops count as up. With no connector configured it is `ok` |

`runs.pending` are runs queued for a worker, `runs.in_flight` runs executing now. Each
request commits one small write to prove the database takes it.

### `GET /metrics`

200, `text/plain; version=0.0.4; charset=utf-8`: the Prometheus exposition. See
[Metrics](metrics.md). With `metrics.listen` set, the same response is also served over
TCP on that address; that endpoint has no other route.

### `POST /v1/events`

Publishes an event. Body:

| Field | Type | Meaning |
|---|---|---|
| `type` | string, required | a concrete event type (no `*`), up to 8 dot-separated segments of `[a-z0-9_-]` |
| `source` | string | who publishes it; default `api` (connectors send their name) |
| `payload` | any JSON | the data |
| `dedup_key` | string | a second event with the same key is dropped |
| `parent_id` | string | an existing event; the new one gets its depth + 1 and, without `correlation_id`, its correlation id |
| `correlation_id` | string | the correlation id; wins over the parent's; without either, a new id is minted |

The core assigns `id`, `seq`, `ts` and `depth`. A body with one of these keys, or with
any other key that is not in the table, gets a 400.

201 `{"status": "inserted", "event": <EventRecord>, "tasks": [<TaskMatch>…], "waiting_runs": ["run_…"]}`
or 200 `{"status": "duplicate", "dedup_key": "<key>"}`. The core works out `tasks` and
`waiting_runs` before it dispatches the event: a task whose trigger matches is
`pending`, and `waiting_runs` lists the waiting runs whose wait the event matches. Both
are `null` when the core could not work them out; the event is inserted all the same.
An invalid type or an unknown parent is a 400.

### `GET /v1/events`

| Query | Meaning | Default |
|---|---|---|
| `type` | an exact type or a pattern where `*` is one whole segment | all |
| `after` | a `seq`; return events after it, oldest first | none |
| `limit` | how many, 1 to 1000 | 50 |

200 `{"events": [<EventRecord>…]}`. Without `after`, the newest `limit` events in
ascending order; with it, the events after that sequence number.

### `GET /v1/events/{id}`

200 `<EventRecord>`, or 404 `unknown event "<id>"`.

### `GET /v1/events/{id}/tasks`

What the event did to each task:

```json
{ "event_id": "evt_01J8Z3…", "dispatched": true,
  "runs": [],
  "tasks": [{ "task": "classify_email", "outcome": "started", "reason": null,
              "detail": null, "run_id": "run_01J8Z3…" }],
  "waiting_runs": [] }
```

`dispatched` is `false` until the dispatcher has read the event. `runs` lists every
`RunRecord` the event started, also runs of tasks that are no longer configured.
`tasks` has one `TaskMatch` per task of the active configuration, in config order.
`waiting_runs` lists the waiting runs whose wait the event matches. A wait ends when its
event is dispatched, so the list is empty once `dispatched` is `true`. 404
`unknown event "<id>"`.

### `POST /v1/runs`

Starts a task by hand. Body:

| Field | Type | Meaning |
|---|---|---|
| `task` | string, required | the task name |
| `event` | `{ "type"?: string, "payload"?: any }` | the event the action sees as its trigger; type defaults to `manual.input`, payload to `null` |
| `correlation_id` | string | thread the run under an existing happening |

201 `{"event_id": "<the manual.run event>", "run": <RunRecord>}`; the run is already
`queued`. Filters and cron overlap do not apply; `concurrency` and `workers` do. 404
`unknown task "<task>"`. 409 `task "<task>" is paused: …` for a paused task.

### `GET /v1/runs`

| Query | Meaning | Default |
|---|---|---|
| `status` | `queued`, `running`, `waiting`, `succeeded`, `failed` or `cancelled` | all |
| `task` | one task | all |
| `limit` | 1 to 1000 | 50 |

200 `{"runs": [<RunRecord>…]}`, newest first.

### `GET /v1/runs/{id}`

200 `<RunRecord>`, or 404 `unknown run "<id>"`.

### `POST /v1/runs/{id}/cancel`

Ends a `queued`, `running` or `waiting` run as `cancelled` and publishes
`task.<name>.cancelled` ([Events](events.md)). A queued run never starts, a waiting run
stops waiting, and a running run's action is aborted the way a timeout aborts it: a
process is killed, an agent session is cancelled. A run waiting out a retry backoff
makes no further attempt. No `emit` rule and no `state_updates` apply. A Message
Batches request the run already submitted still completes and is billed.

- 200 `<RunRecord>` with `status: "cancelled"` and `finished_at` set.
- 202 `<RunRecord>` still `running`: the action has not stopped within 5 seconds. The
  run ends `cancelled` once it does. An action that finishes before it notices the
  cancel ends as it finished.
- 404 `unknown run "<id>"`; 409 `run "<id>" is already <status>` for a finished run.

### `GET /v1/runs/{id}/transcript`

| Query | Meaning | Default |
|---|---|---|
| `after` | an entry id; return entries after it | 0 |
| `limit` | 1 to 5000 | 1000 |

200 `{"run_id": "...", "entries": [<TranscriptEntry>…]}`. Empty for runs of actions
other than `agent`. 404 for an unknown run.

### `GET /v1/runs/{id}/attempts`

200 `{"run_id": "...", "attempts": [<AttemptRecord>…]}`, oldest first. An
`AttemptRecord` is `{run_id, attempt, status, started_at, finished_at, error, stdout,
stderr}`. `status` is `running`, `waiting` (the run is parked in a `wait`; the attempt
goes on when it resumes), `succeeded`, `failed`, `cancelled` or `interrupted` (a stop or
a restart cut it short). `stdout` and `stderr` are the last 4096 characters of what the
attempt's `shell` steps printed, with each secret value replaced by `[secret:<name>]`; a cut tail starts
with `…`, and a stream that printed nothing is `null`. Other action kinds record the
attempt with no output. 404 for an unknown run.

### `GET /v1/runs/{id}/wait`

200 `{"run_id": "...", "wait": {"type", "filter", "expires_at", "on_timeout", "created_at"}}`
for a `waiting` run: the event type or pattern it waits for, the rendered filter or
`null`, the deadline or `null` for none, and what happens at the deadline (`fail` or
`succeed`). `wait` is `null` for a run that is not waiting. 404 for an unknown run.

### `GET /v1/runs/{id}/ledger`

200 `{"run_id": "...", "entries": [<LedgerEntry>…], "total_usd": 0.0123}`, the run's
model calls in order. 404 for an unknown run.

### `GET /v1/tasks`

200 `{"tasks": [<TaskEntry>…]}`, the tasks of the active configuration in the order the
tasks files define them.

### `POST /v1/tasks/{name}/pause`, `POST /v1/tasks/{name}/resume`

`pause` stops the task from starting new runs, whatever triggers it: its events, its
cron ticks and `POST /v1/runs` (409). Events that arrive while it is paused start no
run, then or later. Runs already queued, running or waiting carry on; a waiting run
still resumes when its event arrives. A pause belongs to the task name and survives a
reload and a restart. Pausing a paused task keeps its `paused_at`.

`resume` starts runs again for events from then on. Both answer 200 `<TaskEntry>`, or
404 `unknown task "<name>"` for a task not in the active configuration.

### `GET /v1/cost`

| Query | Meaning | Default |
|---|---|---|
| `since` | a duration (`7d`, `24h`, `30m`, `500ms`) back from now, or a timestamp | `24h` |
| `by` | `task`, `model`, `provider` or `day` | `task` |

200:

```json
{ "since": "2026-10-03T08:00:00.000Z", "by": "task",
  "rows": [{ "key": "classify_email", "calls": 12, "in_tok": 9000, "out_tok": 600,
             "cache_read": 8000, "cache_write": 1000, "usd": 0.0123 }],
  "total_usd": 0.0123 }
```

Rows are ordered by cost, highest first. An unparseable `since` is 400 with the issue
`a duration like 7d or an ISO timestamp`.

### `GET /v1/state/{ns}`

200 `{"entries": [<StateEntry>…]}`, every key of the namespace, ordered by key.

### `GET`, `PUT`, `DELETE /v1/state/{ns}/{key}`

- `GET`: 200 `<StateEntry>`, or 404 `no state for <ns>/<key>`.
- `PUT` with body `{"value": <any JSON>}`: 200 `<StateEntry>` with the new value (an
  upsert). A body without `value` is 400 `invalid state value`.
- `DELETE`: 200 `{"deleted": true|false}`.

Resetting a cursor with `PUT` is the normal way to make a poll fetch again; dedup keys
on already-seen items still drop them.

### `GET /v1/connectors`

200 `{"connectors": [<ConnectorEntry>…]}`: the supervised processes first, then the
built-in pollers.

### `POST /v1/connectors/{name}/restart`

Kills the connector, resolves its secrets again and respawns it. 200 with the new
`ConnectorEntry` (without `builtin`). 404 `unknown connector "<name>"`. 409 for a
built-in poller (it re-reads its secrets on every poll) and for a connector in its own
unit that serves no ops (restart it with `systemctl restart 247-agent-connector@<name>`).
A connector in its own unit that serves ops is reconnected, which starts a fresh process
in the unit.

### `POST /v1/reload`

Re-reads `agent.yaml`, the manifests and the tasks files and applies them together.
Always 200 with a `ReloadReport`; `"ok": false` means the previous config stays active.

### `POST /v1/backup`

Copies the database with SQLite's online backup API to a temporary file next to it, and
answers 200 with that file as the body (`application/vnd.sqlite3`, with
`content-length`). The copy is consistent; runs and writes continue while it is made.
The daemon deletes the temporary file once it is sent or the client disconnects. `oa
backup` is the client.

## Records

### EventRecord

```json
{ "seq": 1041, "id": "evt_01J8Z3ABCDEFGHJKMNPQRSTVWX", "type": "email.received",
  "source": "email", "ts": "2026-10-04T08:00:00.000Z",
  "correlation_id": "cor_01J8Z3…", "parent_id": "evt_01J8Z2…", "dedup_key": "email:<id@example.com>",
  "depth": 1, "payload": { "from": "editor@example.com" } }
```

`seq` is the dispatch order and the only reliable ordering; ids are time-sortable at
millisecond resolution. `parent_id`, `dedup_key` and `payload` may be `null`. See
[Events](events.md).

### RunRecord

```json
{ "id": "run_01J8Z3…", "task": "classify_email", "event_id": "evt_01J8Z3…",
  "correlation_id": "cor_01J8Z3…", "status": "succeeded", "attempt": 1,
  "created_at": "…", "started_at": "…", "finished_at": "…",
  "result": { "kind": "general_change" }, "error": null }
```

Statuses: `queued` (created, `attempt` 0), `running` (an attempt is executing, or a
retry is waiting out its backoff with `error` set), `waiting` (parked for an event or a
timeout), `succeeded`, `failed`, `cancelled` (ended by `POST /v1/runs/{id}/cancel`, with
`error: "cancelled on request"`). A run re-queued because its wait ended continues the
same attempt; a retry is a new attempt. `started_at` is when the first attempt started,
so the time to `finished_at` includes retries and waits. A `succeeded` run has `error:
null`, also after a failed attempt.

### TaskEntry

```json
{ "name": "fetch_email", "trigger": "cron", "paused_at": null,
  "schedule": "*/5 * * * *", "next_fire": "2026-10-04T08:05:00.000Z",
  "types": null, "filter": null,
  "last_run": { "id": "run_01J8Z3…", "status": "succeeded",
                "created_at": "…", "finished_at": "…" },
  "runs": { "queued": 0, "running": 0, "waiting": 0, "succeeded": 41, "failed": 1,
            "cancelled": 0, "total": 42 } }
```

`trigger` is `cron`, `event` or `manual`. `paused_at` is when the task was paused, or
`null` when it runs normally. A cron task has `schedule` and `next_fire`. An event task
has `types` (the types or patterns of `type` or `type_any`) and `filter`. The other
fields are `null`. `last_run` is the newest run, whatever its status, or `null`. `runs`
counts the runs of the task that the database still holds, per status; retention
deletes old ones.

### TaskMatch

```json
{ "task": "classify_email", "outcome": "no_match", "reason": "filter",
  "detail": "payload.from == 'editor@example.com'", "run_id": null }
```

| `outcome` | Meaning | `reason` |
|---|---|---|
| `started` | the event started the run `run_id` | `null` |
| `pending` | the trigger matches and the event is not dispatched yet | `null` |
| `skipped` | the trigger matches but no run started | `depth`: the event is deeper than `limits.max_event_depth`; `paused`: the task is paused; `overlap`: a cron tick while a run was active (`overlap: skip`); `chain_runs`: the chain reached `limits.max_runs_per_chain`; `unknown`: none of these holds now |
| `no_match` | the trigger does not match | `own_source`: a run of the task produced the event; `type`: the trigger names another type, or the event is a `cron.tick` or `manual.run` for another task; `filter`: the filter is false; `filter_error`: the filter threw |

`detail` gives context: the source, what the trigger wants (`wants order.received`),
the filter, the error of the filter, or the limit. The core explains a skip from the
pause, the limits and the runs as they are when you ask. These are the conditions at
dispatch unless one of them changed after it.

### LedgerEntry

```json
{ "id": 77, "run_id": "run_01J8Z3…", "task": "classify_email", "provider": "anthropic",
  "model": "claude-haiku-4-5", "in_tok": 812, "out_tok": 44, "cache_read": 700, "cache_write": 0,
  "usd": 0.00099, "priced_by": "table", "ts": "…" }
```

`priced_by` is `table` (the built-in or configured price), `provider` (the provider
reported the cost), `unpriced` (recorded at $0; the run failed) or `estimate` (the
worst case of a call cut off by a timeout, a cancel or a stop while the provider was
answering; $0 when the model has no price).

### TranscriptEntry

```json
{ "id": 9, "run_id": "run_01J8Z3…", "ts": "…", "turn": 1, "kind": "tool_call",
  "text": null, "data": { "id": "call_1", "tool_kind": "execute", "title": "npm run build", "command": "npm run build", "status": "completed" } }
```

`kind` is one of `prompt`, `text`, `thought`, `tool_call`, `tool_call_update`,
`permission`, `usage`, `stop`, `cancel`, `result`.

### StateEntry

```json
{ "namespace": "email", "key": "last_uid", "value": 4711, "updated_at": "…" }
```

### ConnectorEntry

A supervised process:

```json
{ "name": "email", "transport": "stdio", "managed_by": "core", "sandbox": "none",
  "network": "host", "state": "up", "pid": 4310, "restarts": 0, "error": null,
  "health": { "ok": true, "checked_at": "…", "failures": 0 }, "builtin": null }
```

`transport` is `stdio`, `none` or `acp`; `sandbox` is `none` or `bwrap`; `network` is
`host`, `none` or `allowlist`; `state` is `starting`, `up`, `down`, `stopped` or
`external`; `health` is `null` without `health:` in the manifest, and `ok` is `null`
before the first check.

A built-in poller has no `health` key:

```json
{ "name": "github_prs", "builtin": "poller", "transport": "none", "managed_by": "core",
  "sandbox": "none", "network": "host", "state": "up", "pid": null, "restarts": 0, "error": null }
```

### ReloadReport

```json
{ "ok": true,
  "files": [{ "file": "/etc/247-agent/agent.yaml", "ok": true }, { "file": "…/tasks.d/site.yaml", "ok": false, "issues": [{ "path": "tasks[2].action.cmd", "message": "…" }] }],
  "restart_required": ["db"],
  "connectors": { "added": ["jira"], "removed": [], "changed": ["email"] },
  "tasks": 9 }
```

`files` lists `agent.yaml`, then the manifests, then the tasks files. `restart_required`
names the fixed keys (`db`, `socket`, `secrets`) whose value changed and stays in force
only after a restart. `connectors` is present only when the connector set was applied.
`error` is present only with `"ok": false` when every file is valid but the connector
set could not be switched; the previous connectors are put back.
