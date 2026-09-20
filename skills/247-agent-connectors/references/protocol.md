# Connector protocol (any language)

The core needs two HTTP calls over its Unix socket and, for ops, MCP over stdio.

## Emit an event (connector → core)

```
POST http://unix:<OA_CORE_SOCKET>:/v1/events
content-type: application/json

{ "type": "webhook.received", "source": "webhook",
  "payload": { "repo": "x" },
  "dedup_key": "webhook:<delivery-id>",       # optional; duplicate → dropped
  "correlation_id": "cor_…",                  # optional; thread under an existing happening
  "parent_id": "evt_…" }                      # optional; inherits correlation id, depth + 1
```

Responses: `201` inserted (`{status: "inserted", event: {...}}`), `200` duplicate
(`{status: "duplicate", dedup_key}`), `400` invalid. The core assigns `id` and `ts`.

```
curl --unix-socket "$OA_CORE_SOCKET" -X POST http://unix/v1/events \
  -H 'content-type: application/json' \
  -d '{"type":"webhook.received","source":"webhook","payload":{"repo":"x"}}'
```

Event type names are dot-separated lowercase segments (`chat.reply`,
`email.received`). Use `<connector>.<what happened>`.

## State (cursor, last seen id)

```
GET    /v1/state/<name>            → all keys in the connector's namespace
GET    /v1/state/<name>/<key>      → {namespace, key, value, updated_at} or 404
PUT    /v1/state/<name>/<key>      body {"value": ...}
DELETE /v1/state/<name>/<key>
```

Use your own `OA_CONNECTOR_NAME` as the namespace. Tasks can read it as
`${state.<name>.<key>}`.

## Ops (core → connector): MCP over stdio

With `transport: stdio`, the process is an MCP server: JSON-RPC on stdin/stdout, tools
listed by `tools/list`, called by `tools/call`. The core holds one client connection
for the daemon's lifetime and calls only the ops in the manifest allowlist.

- Return the result as `structuredContent`, or as one text content block containing
  JSON (the core parses it). The calling task's `result` is that value.
- Signal failure with `isError: true` and a message; the calling run fails without
  retry.
- Never write anything else to stdout. Logs go to stderr.
- Any MCP SDK works (TypeScript, Python, Go, …); any off-the-shelf MCP server works
  unchanged.

## Replies to questions (approval flows)

An `ask` op receives a `correlation_id` from the task (`${event.correlation_id}`),
stores it with the outgoing question (chat message id → correlation id), and when the
human answers, emits `chat.reply` with `payload.correlation_id` and `payload.approved`
plus `correlation_id` on the event itself. The waiting task matches on
`payload.correlation_id`.

## Lifecycle

Spawned by the core at start, restarted on exit with exponential backoff
(`restart.base` doubling to `restart.max`, reset after 30s of uptime). Exit non-zero on
unrecoverable errors. Expect to be restarted at any time: keep state in the core.
