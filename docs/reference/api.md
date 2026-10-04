# HTTP API reference

Every route the daemon serves on its Unix socket, with parameters, bodies and status
codes. This is what `oa` and the connectors use, and what you use for anything the CLI
does not cover.

## Transport

- HTTP/1.1 over the Unix socket named by `socket` in `agent.yaml`, default
  `/run/247-agent/core.sock`, created with mode `0660`. There is no authentication:
  anything that can open the socket is trusted.
- Requests and responses are JSON (`application/json; charset=utf-8`). A body larger
  than 1 MiB is refused with 413. A non-empty body is parsed as JSON whatever its
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

200:

```json
{ "ok": true, "pid": 4242, "started_at": "2026-10-04T08:00:00.000Z", "uptime_s": 3600,
  "config_file": "/etc/247-agent/agent.yaml", "tasks": 8, "runs": { "pending": 0, "in_flight": 1 } }
```

`runs.pending` are runs queued for a worker, `runs.in_flight` runs executing now.

### `GET /metrics`

200, `text/plain; version=0.0.4; charset=utf-8`: the Prometheus exposition. See
[Metrics](metrics.md).

### `POST /v1/events`

Publishes an event. Body:

| Field | Type | Meaning |
|---|---|---|
| `type` | string, required | a concrete event type (no `*`), up to 8 dot-separated segments of `[a-z0-9_-]` |
| `source` | string | who publishes it; default `api` (connectors send their name) |
| `payload` | any JSON | the data |
| `dedup_key` | string | a second event with the same key is dropped |
| `parent_id` | string | an existing event; the new one inherits its correlation id and gets its depth + 1 |
| `correlation_id` | string | used when no parent supplies one; else a new id is minted |

201 `{"status": "inserted", "event": <EventRecord>}` or 200
`{"status": "duplicate", "dedup_key": "<key>"}`. An invalid type or an unknown parent is
a 400.

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

### `POST /v1/runs`

Starts a task by hand. Body:

| Field | Type | Meaning |
|---|---|---|
| `task` | string, required | the task name |
| `event` | `{ "type"?: string, "payload"?: any }` | the event the action sees as its trigger; type defaults to `manual.input`, payload to `null` |
| `correlation_id` | string | thread the run under an existing happening |

201 `{"event_id": "<the manual.run event>", "run": <RunRecord>}`; the run is already
`queued`. Filters and cron overlap do not apply; `concurrency` and `workers` do. 404
`unknown task "<task>"`.

### `GET /v1/runs`

| Query | Meaning | Default |
|---|---|---|
| `status` | `queued`, `running`, `waiting`, `succeeded`, `failed` or `cancelled` | all |
| `task` | one task | all |
| `limit` | 1 to 1000 | 50 |

200 `{"runs": [<RunRecord>…]}`, newest first.

### `GET /v1/runs/{id}`

200 `<RunRecord>`, or 404 `unknown run "<id>"`.

### `GET /v1/runs/{id}/transcript`

| Query | Meaning | Default |
|---|---|---|
| `after` | an entry id; return entries after it | 0 |
| `limit` | 1 to 5000 | 1000 |

200 `{"run_id": "...", "entries": [<TranscriptEntry>…]}`. Empty for runs of actions
other than `agent`. 404 for an unknown run.

### `GET /v1/runs/{id}/ledger`

200 `{"run_id": "...", "entries": [<LedgerEntry>…], "total_usd": 0.0123}`, the run's
model calls in order. 404 for an unknown run.

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
Always 200 with a `ReloadReport`; `"ok": false` means nothing changed.

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
timeout), `succeeded`, `failed`. `cancelled` is accepted as a filter but no code path
sets it. A run re-queued because its wait ended continues the same attempt; a retry is a
new attempt.

### LedgerEntry

```json
{ "id": 77, "run_id": "run_01J8Z3…", "task": "classify_email", "provider": "anthropic",
  "model": "claude-haiku-4-5", "in_tok": 812, "out_tok": 44, "cache_read": 700, "cache_write": 0,
  "usd": 0.00099, "priced_by": "table", "ts": "…" }
```

`priced_by` is `table` (the built-in or configured price), `provider` (the provider
reported the cost) or `unpriced` (recorded at $0; the run failed).

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
