# HTTP API on the Unix socket

Plain JSON over `node:http`. Errors are `{error, issues?}` with status 400 (invalid),
404 (unknown), 405 (method), 413 (body too large).

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Daemon status |
| `POST /v1/events` | Publish an event `{type, source?, payload?, dedup_key?, parent_id?, correlation_id?}` → 201 inserted, 200 duplicate |
| `GET /v1/events/{id}` | One event |
| `POST /v1/runs` | Manual run `{task, type?, payload?, correlation_id?}` → 201 `{run_id, …}` |
| `GET /v1/runs?status=&task=&limit=` | Runs, newest first. `status`: `queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled` |
| `GET /v1/runs/{id}` | One run: status, input event, result, error, attempts |
| `GET /v1/state/{ns}` | All keys in a namespace |
| `GET /v1/state/{ns}/{key}` | `{namespace, key, value, updated_at}` |
| `PUT /v1/state/{ns}/{key}` | Body `{"value": …}` |
| `DELETE /v1/state/{ns}/{key}` | Remove a key |

curl form:

```
curl --unix-socket "$OA_CORE_SOCKET" 'http://unix/v1/runs?status=failed&limit=10'
curl --unix-socket "$OA_CORE_SOCKET" http://unix/v1/state/email
curl --unix-socket "$OA_CORE_SOCKET" -X PUT http://unix/v1/state/email/last_uid \
  -H 'content-type: application/json' -d '{"value": 0}'
```

Resetting a cursor (the `PUT` above) is the normal way to make a poll re-fetch;
remember `dedup_key`s on already-seen items still drop them.

Not yet implemented, though listed in the architecture: `oa events tail`,
`oa runs ls|show|logs`, `oa cost`, `oa connectors status`, `/metrics`.
