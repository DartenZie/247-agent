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
  user: "${secrets.email_user}"               # free-form: each connector defines its own
  password: "${secrets.email_pass}"           # (email: connectors/email/README.md)
  incoming: { protocol: imap, host: imap.example.cz, folder: INBOX }
  outgoing: { host: smtp.example.cz, from: info@example.cz, footer: "-- \nOffice" }
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

## The email connector (`connectors/email`)

IMAP or POP3 in (`incoming`), SMTP out (`outgoing`), each side optional. Ops `fetch_new`
(`{since_uid?, folder?, limit?}` → `{emails, last_uid}`; POP3 tracks delivered UIDLs in
state instead of a cursor), `mark_read` (IMAP only) and `send` (the configured `footer` is
appended to every mail; `in_reply_to` threads replies). `initial: none` (default) makes
the first fetch skip mail already in the box. Full reference: `connectors/email/README.md`.

## Using an existing MCP server

```yaml
name: github
exec: ["npx", "-y", "@modelcontextprotocol/server-github"]
transport: stdio
ops: [list_pull_requests, get_pull_request]
env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secrets.github_token}" }
```

Turn its ops into events with a cron task that calls the op and fans out with
`emit … each` and a `dedup_key` (the built-in `poller` that does this generically is
planned, not implemented).

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
