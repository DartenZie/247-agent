# Connector manifest

One file per connector under `connectors.d/`, or an entry in the `connectors:` list of
`agent.yaml`. Names must be unique across both.

```yaml
name: email                                   # [a-z][a-z0-9_-]*
exec: ["247-agent-connector-email"]           # any executable; argv, no shell; the install's bin/ is first on PATH
cwd: .                                        # relative to the manifest (optional)
transport: stdio                              # stdio = MCP server on stdin/stdout; none = emits only; acp = an ACP agent (below)
emits: [email.received]                       # documentation of the event types it publishes
ops: [fetch_new, mark_read, send]             # MCP tools the core may call; [] = any
config:                                       # passed as OA_CONFIG_JSON, secrets rendered
  user: "${secrets.email_user}"               # free-form: each connector defines its own
  password: "${secrets.email_pass}"           # (email: connectors/email/README.md)
  incoming: { protocol: imap, host: imap.example.com, folder: INBOX }
  outgoing: { host: smtp.example.com, from: info@example.com, footer: "-- \nOffice" }
env: { NODE_ENV: production }                 # extra environment for the process
restart: { base: 1s, max: 60s }               # crash backoff, doubling; reset after 30s up
health: { interval: 60s, timeout: 10s, failures: 3 }   # stdio only: MCP ping every interval; 3 misses in a row = crash, respawn
```

- `config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only.
- `ops` is a security boundary: a task or an agent given this connector can call only
  the listed tools. Give an agent-facing connector a read-only op set and put `send` on
  a separate manifest if needed.
- The `emits` list is documentation and shape-checking, not a filter.
- Use `transport: none` for a pure emitter (a webhook receiver, a bot that only
  forwards messages).
- `health` pings the MCP server; `none` and `acp` connectors have none and reject it
  (their process exit is watched anyway). `oa connector list` shows `health=ok`,
  `failing(n)` or `unchecked`; `connector.unhealthy` / `connector.health_failed` in the log.

## An ACP agent as a connector

```yaml
name: claude
exec: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]   # any Agent Client Protocol program
transport: acp
env: { ANTHROPIC_API_KEY: "${secrets.anthropic_api_key}" }     # the agent's own model key
sandbox: { backend: bwrap, ro_binds: [/var/lib/247-agent/repos/site] }   # run it in bubblewrap (acp only)
```

`agent` actions name it with `connector: claude` and open one ACP session per run (the
core is the client, protocol version 1). It serves no ops and emits no events, so `ops`
and `emits` must be empty; `config` is refused (no `OA_CONFIG_JSON`: configure the program
through `env`). Same lifecycle as any process connector: crash backoff, `oa connector
restart` to re-read a rotated key, stderr as `connector.output`; `oa connector list`
shows `acp` as its transport and `sandbox=bwrap` when sandboxed.

`sandbox` takes the same forms as on a `shell` action (`bwrap` or `{ backend: bwrap,
ro_binds, rw_binds, extra_args }`) and is the trust boundary ARCHITECTURE §11 asks for:
the program runs for its whole life inside bubblewrap with the OS and the install
read-only, `defaults.agent.work_dir` the only writable path (every run's workspace and
the program's home, `<work_dir>/home/<name>`, for npm and Claude Code caches), the
listed binds, and nothing else: no core socket, no database, no config directory or
secrets file (their directories are masked), no other process, an environment of
`PATH`/`HOME`/`LANG`/`OA_HOME`/`OA_CONNECTOR_NAME` plus the manifest's `env`. Put every
repository the tasks' `git-worktree` workspaces use in `ro_binds` (`rw_binds` only when
the agent itself must commit); `oa validate` refuses a repository the sandbox cannot see,
a bind or `work_dir` covering the daemon's files, and a `cwd` outside every bind. The
network stays open (the model API). Needs `bubblewrap` on the host; otherwise the
connector stays `down` with the spawn error. Other
agents: Codex (`docs/examples/connectors.d/codex.yaml`: `@agentclientprotocol/codex-acp`,
configured through the `CODEX_CONFIG` JSON in `env`, used with `unasked_execute:
sandboxed` on the action), `gemini --experimental-acp`, and the list at
agentclientprotocol.com. The task's `tools`/`bash_allow` policy answers the agent's
permission requests, so prefer agents that ask before acting.

## Environment the supervisor provides

| Variable | Value |
|---|---|
| `OA_CORE_SOCKET` | The core's Unix socket path |
| `OA_CONNECTOR_NAME` | The manifest's `name` |
| `OA_CONFIG_JSON` | `config` as JSON, secrets rendered; read it once at start and delete it from the environment (`connectorEnv()` does) so child processes do not inherit it |

Plus the manifest's `env`, on top of a minimal environment (`PATH`, `HOME`, …). An `acp`
agent gets `OA_CONNECTOR_NAME` and its `env` only; sandboxed, also nothing of the
daemon's environment beyond `PATH`, `HOME`, `LANG`, `OA_HOME`. Stderr lines are logged by
the daemon as `connector.output`.

## The email connector (`connectors/email`)

IMAP or POP3 in (`incoming`), SMTP out (`outgoing`), each side optional. Ops `fetch_new`
(`{since_uid?, folder?, limit?}` → `{emails, last_uid}`; POP3 tracks delivered UIDLs in
state instead of a cursor), `mark_read` (IMAP only) and `send` (the configured `footer` is
appended to every mail; `in_reply_to` threads replies). `initial: none` (default) makes
the first fetch skip mail already in the box. Full reference: `connectors/email/README.md`.

## The ftp connector (`connectors/ftp`)

Files inside one remote directory over `sftp` (password or `private_key`, optional
`host_key_fingerprint`), `ftp` or `ftps` (`tls: explicit|implicit`). Ops `list`, `stat`,
`read`, `write`, `delete`, `rename`, `mkdir`; every path is relative to `root` and confined
to it, `read`/`write` are capped by `max_bytes`. Ops-only: a task fans `list` out with
`each: "${result.entries[?type == 'file']}"` and a `dedup_key` on path, size and mtime
(`connectors/ftp/examples/inbox-import.yaml`). Give agents a manifest copy with
`ops: [list, stat, read]`. Full reference: `connectors/ftp/README.md`.

## The chat connector (`connectors/chat`)

A Telegram bot (`token`, `chat_id`; optional `allowed_chat_ids`, `poll_timeout`, `initial`,
`ask_options`). Push-style: long-polls the Bot API with the offset in state and emits
`chat.message` (`{text, from: {id, name, username}, message_id, chat_id, date, reply_to}`)
for every message in the configured chat, ignoring other chats. Ops `send`
(`{text, parse_mode?, reply_to?}` → `{message_id, chat_id}`) and `ask` (`{text,
correlation_id, options?}` → `{message_id, chat_id, options}`), which posts inline buttons
(`Approve`/`Reject` by default) and stores the question in state; the tap, or a reply
naming an option, is emitted as `chat.reply` with `{correlation_id, approved, choice, text,
from, message_id, chat_id}` and the same `correlation_id` on the event. `approved` is true
for the first option. Full reference: `connectors/chat/README.md`.

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
        - { uid: 1, message_id: "<m1@x>", from: editor@example.com, subject: Spring event, body: Please add it. }
  - name: ftp
    exec: [node, packages/core/test/fixtures/fake-ftp.ts]
    ops: [list, stat, read, write, delete, rename, mkdir]
    config:
      files: { "incoming/orders.csv": "id;qty\n1;2" }     # the in-memory tree it serves
```
