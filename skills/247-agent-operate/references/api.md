# HTTP API on the Unix socket

Plain JSON over `node:http`. Errors are `{error, issues?}` with status 400 (invalid),
404 (unknown), 405 (method), 413 (body too large).

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | `{ok, status, pid, uptime_s, tasks, runs, checks: {dispatcher, database, connectors}}`; `status` is `ok`, `degraded` (some connectors down) or `failing` (dispatcher throwing, database refusing writes, no connector up); 503 when `failing` |
| `POST /v1/events` | Publish an event `{type, source?, payload?, dedup_key?, parent_id?, correlation_id?}` → 201 inserted, 200 duplicate |
| `GET /v1/events?type=&after=&limit=` | The newest `limit` events in `seq` order, or those after a `seq`; `type` exact or a pattern (`*` = one segment) |
| `GET /v1/events/{id}` | One event |
| `POST /v1/runs` | Manual run `{task, event?: {type?, payload?}, correlation_id?}` → 201 `{event_id, run}`; the run is already `queued`. 404 unknown task, 409 paused |
| `GET /v1/runs?status=&task=&limit=` | Runs, newest first. `status`: `queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled` |
| `GET /v1/runs/{id}` | One run: status, input event, result, error, attempts |
| `POST /v1/runs/{id}/cancel` | End a queued, running or waiting run → 200 the run `cancelled`, or 202 still `running` while its action stops; 409 when already finished |
| `GET /v1/tasks` | Configured tasks `{tasks: [{name, trigger, paused_at}]}` |
| `POST /v1/tasks/{name}/pause`, `/resume` | Stop or restart new runs of a task → 200 `{name, trigger, paused_at}`; `POST /v1/runs` of a paused task is 409 |
| `GET /v1/runs/{id}/transcript?after=&limit=` | The agent transcript `{run_id, entries: [{id, ts, turn, kind, text, data}]}`; empty for other action kinds |
| `GET /v1/runs/{id}/ledger` | The run's model calls `{run_id, entries, total_usd}` |
| `GET /v1/state/{ns}` | All keys in a namespace |
| `GET /v1/state/{ns}/{key}` | `{namespace, key, value, updated_at}` |
| `PUT /v1/state/{ns}/{key}` | Body `{"value": …}` |
| `DELETE /v1/state/{ns}/{key}` | Remove a key |
| `GET /v1/cost?since=&by=` | The ledger summed since a duration or timestamp, grouped by `task`, `model`, `provider` or `day` |
| `GET /v1/connectors` | Connectors with `state`, `pid`, `restarts`, `error`, `health` (`{ok, checked_at, failures}` or null) |
| `POST /v1/connectors/{name}/restart` | Kill, re-resolve secrets, respawn (409 for a built-in) |
| `POST /v1/reload` | Re-read and apply agent.yaml, manifests and tasks together → `{ok, files, restart_required, connectors?, tasks}` (200 even when refused; `ok: false` = nothing changed) |
| `GET /metrics` | Prometheus text exposition (`oa_*`) |

curl form:

```
curl --unix-socket "$OA_CORE_SOCKET" 'http://unix/v1/runs?status=failed&limit=10'
curl --unix-socket "$OA_CORE_SOCKET" http://unix/v1/state/email
curl --unix-socket "$OA_CORE_SOCKET" -X PUT http://unix/v1/state/email/last_uid \
  -H 'content-type: application/json' -d '{"value": 0}'
```

Resetting a cursor (the `PUT` above) is the normal way to make a poll re-fetch;
remember `dedup_key`s on already-seen items still drop them.
