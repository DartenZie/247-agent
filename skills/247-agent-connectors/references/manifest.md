# Connector manifest

One file per connector under `connectors.d/`, or an entry in the `connectors:` list of
`agent.yaml`. Names must be unique across both.

```yaml
name: email                                   # [a-z][a-z0-9_-]*
exec: ["node", "connectors/email/dist/main.js"]   # any executable; argv, no shell
cwd: .                                        # relative to the manifest (optional)
transport: stdio                              # stdio = MCP server on stdin/stdout; none = emits only
emits: [email.received]                       # documentation of the event types it publishes
ops: [fetch_new, mark_read, send]             # MCP tools the core may call; [] = any
config:                                       # passed as OA_CONFIG_JSON, secrets rendered
  host: imap.example.cz
  user: "${secrets.imap_user}"
  password: "${secrets.imap_pass}"
  folder: INBOX
env: { NODE_ENV: production }                 # extra environment for the process
restart: { base: 1s, max: 60s }               # crash backoff, doubling; reset after 30s up
health: { interval: 60s }                     # accepted, not used yet
```

- `config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only.
- `ops` is a security boundary: a task or an agent given this connector can call only
  the listed tools. Give an agent-facing connector a read-only op set and put `send` on
  a separate manifest if needed.
- The `emits` list is documentation and shape-checking, not a filter.
- Use `transport: none` for a pure emitter (a webhook receiver, a bot that only
  forwards messages).

## Environment the supervisor provides

| Variable | Value |
|---|---|
| `OA_CORE_SOCKET` | The core's Unix socket path |
| `OA_CONNECTOR_NAME` | The manifest's `name` |
| `OA_CONFIG_JSON` | `config` as JSON, secrets rendered |

Plus the manifest's `env`, on top of a minimal environment (`PATH`, `HOME`, …). Stderr
lines are logged by the daemon as `connector.output`.

## Using an existing MCP server

```yaml
name: github
exec: ["npx", "-y", "@modelcontextprotocol/server-github"]
transport: stdio
ops: [list_pull_requests, get_pull_request]
env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secrets.github_token}" }
```

Turn its ops into events with the built-in poller below, or with a cron task that calls
the op and fans out with `emit … each` and a `dedup_key` when the op takes a cursor.

## Built-in poller (no process)

```yaml
name: github_prs
builtin: poller                               # instead of exec; transport is none, no ops
config:
  schedule: "*/5 * * * *"                     # cron, 5 or 6 fields; optional tz
  connector: github                           # a process connector that serves the op
  op: list_pull_requests
  args: { owner: acme, repo: site, state: open }   # ${secrets.<name>} / ${env.<VAR>} allowed
  items: "pull_requests"                      # JMESPath over the result → array (default: the result)
  item_key: "number"                          # JMESPath over one item → string or number
  event: github.pr_opened                     # one event per new key, the item as payload
  first_run: emit                             # or skip: remember what exists, emit nothing
  keep: 1000                                  # seen keys remembered
  timeout: 30s                                # per op call (optional)
```

- Seen keys: `GET|DELETE /v1/state/<name>/seen`. Events carry `source: <name>` and
  `dedup_key: <name>:<key>`, so a reset never re-emits an item the store already has.
- A tick during a running poll is skipped; a failed poll logs `poller.failed` and waits
  for the next tick. Nothing is emitted and the seen list is untouched on failure.
- `cwd`, `env`, `health`, `ops` and `transport: stdio` are errors on a built-in.
  `emits` defaults to `[event]`. `oa validate` checks the target connector exists, is a
  process and allows the op.

## Fake connector for tests

Point `exec` at a TypeScript file; Node runs it from source because the SDK has no
local imports. Put test data in `config`.

```yaml
connectors:
  - name: email
    exec: [node, packages/core/test/fixtures/fake-email.ts]
    emits: [email.received]
    ops: [fetch_new, mark_read]
    config:
      mails:
        - { uid: 1, message_id: "<m1@x>", from: orchestrator@example.cz, subject: Spring concert, body: Please add it. }
```
