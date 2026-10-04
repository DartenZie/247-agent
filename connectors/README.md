# Connectors

Sub-programs the daemon spawns to talk to the outside world. A connector is any
executable with a manifest; it may **emit events** into the core (`POST /v1/events` on
the Unix socket) and/or **expose operations** as an MCP server on stdio, which
`connector` actions call and `agent` runs can be handed as tools (`mcp_servers`). A third
kind, `transport: acp`, is an Agent Client Protocol agent that `agent` actions open
sessions on. Any language works; existing MCP servers (GitHub, filesystem, …) and ACP
agents are connectors as-is.

One npm workspace package per connector lives here (`connectors/*` in the root
`package.json`). Each `README.md` holds the development notes: source layout, tests, how
to run it by hand. The user documentation for each is under `docs/connectors/`.

| Package | Docs | Events | Ops |
|---|---|---|---|
| `email` | [`docs/connectors/email.md`](../docs/connectors/email.md) | none itself; a cron task fans `fetch_new` out as `email.received` | `fetch_new`, `mark_read`, `send` |
| `ftp` | [`docs/connectors/ftp.md`](../docs/connectors/ftp.md) | none; a task fans `list` out | `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir`, `sync` over SFTP, FTP or FTPS, confined to a `root` |
| `chat` | [`docs/connectors/chat.md`](../docs/connectors/chat.md) | `chat.message`, `chat.reply` (the answer to an `ask`, with the `correlation_id`) | `send`, `ask`; Telegram, or Matrix with `backend: matrix` |
| `webhook` | [`docs/connectors/webhook.md`](../docs/connectors/webhook.md) | one per verified request, per route: `<event>` or `<event>.<type header>` | none (`transport: none`) |
| `github` | [`docs/connectors/github.md`](../docs/connectors/github.md) | via the poller | pull requests, issues, comments, commits, workflow runs, search, labels; confined to `repos` |
| `jira` | [`docs/connectors/jira.md`](../docs/connectors/jira.md) | via the poller | `search` (JQL), issues, comments, transitions; confined to `projects` |
| `poller` | [`docs/connectors/poller.md`](../docs/connectors/poller.md) | one event per new item of any op | none; built into the core |

Any of them can run in its own systemd unit instead of as the daemon's child
(`managed_by: systemd`, `247-agent-connector@<name>.service`):
[`docs/connectors/own-unit.md`](../docs/connectors/own-unit.md).

Where things are documented:

- [`docs/connectors/`](../docs/connectors/index.md): configuring and using every
  connector, the poller, agent programs, and [writing your own](../docs/connectors/custom.md).
- [`docs/internal/connectors.md`](../docs/internal/connectors.md): the protocol,
  supervisor, child environment, health checks, poller internals, `managed_by: systemd`,
  sandbox and network proxy internals (source of truth for contributors).
- [`docs/internal/howto/add-connector.md`](../docs/internal/howto/add-connector.md): the
  procedure for a new bundled connector.
- `skills/247-agent-connectors/`: the agent skill, with manifest, SDK and protocol
  references and `assets/connector-template.ts` to start from.
- `packages/connector-sdk/src/index.ts`: `runConnector`, `defineTool`, `CoreClient`.
- `docs/examples/connectors.d/*.yaml`: example manifests; `oa validate` must keep passing
  on them.

## Rules that hold for every connector

- Read config from `OA_CONFIG_JSON`, never from files. Secrets are already rendered into
  it and must never be logged; delete the variable once read (the SDK's `connectorEnv()`
  does) so a subprocess does not inherit it.
- Keep cursors and other state in the core (`GET|PUT /v1/state/<name>/<key>`), so the
  process stays stateless and restart-safe.
- Log to **stderr**; the daemon records it as `connector.output`. With
  `transport: stdio`, stdout is the MCP channel and a stray `console.log` breaks it.
- Return JSON-serialisable results. Throw to signal an op error; the calling run fails
  without retry. Exit non-zero on unrecoverable errors; the supervisor restarts with
  backoff.
- The manifest's `ops` list is a security boundary. Give an agent-facing connector a
  read-only op set and put mutating ops such as `send` on a separate manifest.
- Poll-style sources (mailboxes, APIs) expose a `fetch_new`-like op with a cursor and
  emit nothing themselves; a cron task fans the result out with `emit … each` and a
  `dedup_key`. Push-style sources (bots, webhooks) emit as messages arrive, with a
  `dedup_key` and, for replies to a question, the `correlation_id` they were given.
- Events carry `source: <manifest name>`, set by the SDK's client from
  `OA_CONNECTOR_NAME`.

## Adding a connector

Follow [`docs/internal/howto/add-connector.md`](../docs/internal/howto/add-connector.md):
the package, the launcher in `bin/`, the bundle entry, the user page under
`docs/connectors/`, the example manifest, the fake fixture, and the smoke rig when a
server can run in a container.
