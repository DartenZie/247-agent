# Connectors

A connector is a separate program the daemon runs so your tasks can talk to the outside
world: a mailbox, a chat, a file server, GitHub, Jira. This page explains what a connector
is, how you declare one, and how the daemon looks after it. Each bundled connector has its
own page, linked at the end.

## What a connector does

A connector can do one or both of these:

- **Emit events** into the daemon. A chat bot emits `chat.message` as messages arrive; a
  webhook receiver emits one event per verified request. Any task with a matching
  trigger then runs.
- **Expose operations** that tasks call. `email.fetch_new`, `email.send`, `ftp.write`,
  `github.create_issue` are operations, "ops" for short. A [`connector`](../tasks/connector.md)
  action calls one; an [`agent`](../tasks/agent.md) task can be handed some of them as
  tools.

Ops are MCP tools (the Model Context Protocol, the interface AI assistants use for
tools), so any existing MCP server works as a connector without changes. Agent programs
such as Claude Code are connectors too, of a third kind: the daemon opens agent sessions
on them instead of calling ops. See [Agent programs](agents.md).

A connector that only lists what exists right now (open pull requests, new issues) needs
no code of its own to become an event source: the built-in [poller](poller.md) calls its
op on a schedule and emits an event per new item.

## The manifest

You declare a connector with a short YAML file, its **manifest**. Manifests live in the
directory `agent.yaml` names under `connectors:` (by convention `connectors.d/`, one file
per connector), or inline in that list.

```yaml
name: email                              # how tasks refer to it: a letter, then letters, digits, _ or -
exec: ["247-agent-connector-email"]      # the program to run; the bundled ones are on PATH
transport: stdio                         # stdio: serves ops over MCP; none: only emits; acp: an agent program
emits: [email.received]                  # the event types it publishes, as documentation
ops: [fetch_new, mark_read, send]        # the ops tasks may call; an empty list allows every op the program serves
config:                                  # handed to the program; each connector defines its own keys
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming: { protocol: imap, host: imap.example.com }
  outgoing: { host: smtp.example.com, from: info@example.com }
restart: { base: 1s, max: 60s }          # crash backoff; these are the defaults
health: { interval: 60s, timeout: 10s, failures: 3 }   # optional: ping it over MCP
```

Values under `config` and `env` may use `${secrets.<name>}` for a credential and
`${env.<VAR>}` for an environment variable of the daemon, and nothing else. The daemon
resolves the secrets when it starts the program and never writes them anywhere.

`transport` has an effective default: `stdio` for a program, `none` for the built-in
poller. A `none` connector cannot list `ops`; an `acp` connector lists neither `ops` nor
`emits` and takes no `config`. Every field is in the
[manifest reference](../reference/manifest.md).

## Lifecycle

- The daemon starts every connector when it starts and stops them when it stops.
- A connector that exits or crashes is restarted after `restart.base` (default `1s`),
  then twice that, and so on up to `restart.max` (default `60s`). Once it has stayed up
  for 30 seconds the backoff starts over from the base. A program that fails at start
  (a bad token, a port in use) therefore loops with a growing delay, and
  `oa connector list` shows its error.
- Whatever the connector writes to its standard error ends up in the daemon's log as
  `connector.output` lines, so `journalctl -u 247-agent -o cat | jq 'select(.msg=="connector.output")'`
  shows its own messages.
- A changed manifest takes effect on `oa reload` (or `systemctl reload 247-agent`): that
  connector is respawned with the new manifest and freshly resolved secrets. New
  manifests are started, removed ones stopped, unchanged ones left alone.
- Secrets are read once, when the program starts. After rotating a credential, run
  `oa connector restart <name>`: the program is killed, its secrets resolved again, and it
  is respawned with the backoff counter reset. The built-in poller re-reads its secrets
  on every poll and needs no restart.

`oa connector list` prints one line per connector, tab-separated:

```
email       up      stdio                               pid=4120  restarts=0  health=ok
chat        down    stdio                               pid=-     restarts=3  error="chat: getMe: Unauthorized (401)"
claude      up      acp sandbox=bwrap net=allowlist     pid=4188  restarts=0
github_prs  up      builtin                             pid=-     restarts=0
```

The state is `starting`, `up`, `down`, `stopped` or `external` (a connector in its own
systemd unit that serves no ops). `sandbox=bwrap` and `net=allowlist` or `net=none`
appear for a sandboxed agent program, `unit=247-agent-connector@<name>` for a connector
in its own unit, and `health=` for a manifest with health checks: `ok`, `failing(2)` or
`unchecked`.

## Health checks

A `stdio` connector can be pinged:

```yaml
health: { interval: 60s, timeout: 10s, failures: 3 }
```

Every `interval` the daemon sends an MCP ping. A ping that gets no answer within
`timeout`, or an error, counts as a miss; `failures` misses in a row are treated like a
crash: the process is killed and respawned with the restart backoff. `timeout` defaults
to `10s` and `failures` to `3`. A `none` or `acp` connector has no MCP server to ping and
refuses `health`; its process exit is watched instead.

## The `ops` list is a security boundary

A task or an agent that is handed a connector can call only the ops its manifest lists.
That makes `ops` the place to limit what a connector can do, independently of the
program. The pattern for agents: keep the full manifest for your deterministic tasks and
declare a second manifest, under another name, with the read-only ops for the agent.

```yaml
name: ftp_readonly
exec: ["247-agent-connector-ftp"]
transport: stdio
ops: [list, stat, read]
config:
  host: sftp.example.com
  user: "${secrets.ftp_user}"
  password: "${secrets.ftp_pass}"
  root: /srv/exchange
```

An `ops: []` manifest allows every op the program serves, which is right for an existing
MCP server whose tool list you do not control yet: run one op with `oa run` to see what
it serves, then pin the ones you use.

## What a connector receives

A connector started by the daemon gets a small environment, not the daemon's whole one:

| Variable | Value |
|---|---|
| `OA_CORE_SOCKET` | the daemon's Unix socket, for emitting events and reading state |
| `OA_CONNECTOR_NAME` | the manifest's `name` |
| `OA_CONFIG_JSON` | the manifest's `config` as JSON, secrets filled in |
| `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM` | inherited from the daemon when set; `PATH` starts with the install's `bin/`, so the bundled connectors and the daemon's own `node` are found first |
| the manifest's `env` | added on top |

A connector keeps nothing on disk. Cursors and other memory go into the daemon's state
store under the connector's own name (`${state.email.last_uid}` in a task;
`GET /v1/state/email` over the API), so a connector can be restarted at any time. The
bundled connectors delete `OA_CONFIG_JSON` from their environment once they have read it,
so a program they start does not inherit the secrets.

An agent program (`transport: acp`) gets only `OA_CONNECTOR_NAME` and its manifest's
`env`: no socket and no config, since it must not reach the daemon. Sandboxed, it gets
even less; see [Agent programs](agents.md).

## The bundled connectors

| Connector | What it is | Events | Ops |
|---|---|---|---|
| [`email`](email.md) | IMAP or POP3 in, SMTP out | none itself; a cron task fans `fetch_new` out as `email.received` | `fetch_new`, `mark_read`, `send` |
| [`ftp`](ftp.md) | files on an SFTP, FTP or FTPS server, confined to one directory | none; a task fans `list` out | `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir`, `sync` |
| [`chat`](chat.md) | a Telegram bot or a Matrix user, for messages and approvals | `chat.message`, `chat.reply` | `send`, `ask` |
| [`webhook`](webhook.md) | HTTP in: verified requests become events | one per request, named by route | none |
| [`github`](github.md) | GitHub's REST API, confined to listed repositories | none; pair with the poller | pull requests, issues, comments, commits, workflow runs, labels |
| [`jira`](jira.md) | Jira Cloud or Data Center, confined to listed projects | none; pair with the poller | search, issues, comments, transitions |
| [`poller`](poller.md) | built in, no process: any list op as an event source | one per new item | none |

Example manifests for all of them are in
[`docs/examples/connectors.d/`](../examples/connectors.d/).

Further pages: [Agent programs](agents.md) for Claude Code and Codex as connectors,
[A connector in its own unit](own-unit.md) for one that needs privileges, and
[Writing your own](custom.md).
