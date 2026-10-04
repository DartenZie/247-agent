# Connectors

The connector protocol, the manifest contract, the supervisor that runs connectors, the
built-in poller, the SDK and the bundled connectors. Open this when touching
`packages/core/src/connectors/`, `packages/connector-sdk/`, a manifest schema, or a
connector under `connectors/`. What the sandboxes hide is in [`security.md`](security.md);
the agent session on top of an `acp` connector is in [`agent-action.md`](agent-action.md).

## The protocol

A connector is any executable with a manifest. It may do one or both halves:

- **Events out**: `POST /v1/events` on the core socket with `{type, source, payload?,
  dedup_key?, parent_id?, correlation_id?}`; 201 inserted, 200 duplicate. `source` is
  whatever the connector sends; the SDK sends its manifest name. Push-style connectors
  (a chat bot, a webhook receiver) use this. Poll-style ones do not: a cron task calls
  their op and fans the result out with `emit … each`, which keeps polling, dedup and
  routing in the core where they are observable.
- **Ops in**: the connector is an MCP server on stdio (`tools/list`, `tools/call`). The
  core holds one client connection per connector for the daemon's lifetime and calls
  only the ops the manifest's `ops` allows (`[]` = whatever the server lists). A result
  is `structuredContent`, else one text block parsed as JSON when it parses, else the
  string; several texts become an array; `isError` becomes `ConnectorOpError`
  (non-retryable, `<connector>.<op>: <text>`). The same tools reach an agent session
  through the bridge in [`agent-action.md`](agent-action.md).
- **State**: `GET|PUT|DELETE /v1/state/<name>/<key>`, so a connector keeps nothing on
  disk and can be restarted at any time.

A manifest with `transport: acp` is a third kind: an Agent Client Protocol agent the
core opens sessions on. It serves no ops and emits no events; the supervisor gives it
the same lifecycle (spawn, backoff, `oa connector restart`, `connector.output` from its
stderr) and nothing else.

## The manifest contract

`config/connector.ts` (`ConnectorManifest`, strict). The user table is
`docs/reference/manifest.md`; the refinements that shape the code paths:

- Exactly one of `exec` (argv, no shell) or `builtin: poller`. The effective `transport`
  is `stdio` for a process and `none` for a built-in when unset; `parseManifest` fills it
  in, and fills a poller's `emits` with its `config.event`, so the core never sees an
  unset transport.
- `ops` only with an effective `stdio`; `emits` and `ops` empty on `acp`; `config`
  refused on an `acp` process (configure the agent program through `env`); `cwd`, `env`
  and `health` refused on a built-in.
- `health` only on an effective `stdio` process (a `managed_by: systemd` stdio connector
  included); `none` and `acp` are watched by process exit.
- `sandbox` with a backend other than `none` only on `acp`: every other connector needs
  the core socket, which the sandbox hides. `network` needs `backend: bwrap` and refuses
  `--share-net` in `extra_args`.
- `managed_by: systemd` not on a built-in (no process) nor on `acp` (confine the agent
  with `sandbox` instead); `socket` only with it and only on `stdio`, default
  `/run/247-agent-connector/<name>/mcp.sock`.
- `config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only, and
  `secrets` never as a whole. Names are unique across files and inline entries.

## The supervisor

`connectors/supervisor.ts` owns every connector process and the clients on top of them.

**Spawn.** A `stdio` connector is started through the MCP SDK's `StdioClientTransport`
with its stderr piped; a `none` connector through `execa` with `extendEnv: false`; an
`acp` connector through `AcpAgent.spawn` (`connectors/acp.ts`), inside `bwrap` when the
manifest says so. Stderr lines (and stdout of a `none` process) are logged as
`connector.output`, cut at 2000 characters. Spawn happens at start, after a crash, on
`oa connector restart`, and on a reload that changed the manifest.

**Environment** (`connectors/child-env.ts`, `connectorChildEnv`). The base is the MCP
SDK's default set, because `createCore` passes no `env`: `HOME`, `LOGNAME`, `PATH`,
`SHELL`, `TERM`, `USER` copied from the daemon, with `PATH` already prefixed by
`<OA_HOME>/bin` and the daemon's Node (`home.ts`), which is how `exec:
["247-agent-connector-email"]` and `exec: ["node", …]` resolve. `OA_HOME` itself is not
in that set; the `bin/` launchers export it themselves. On top:

| Kind | Added |
|---|---|
| `stdio`, `none` | the manifest's `env` rendered with `{secrets, env: base}`, then `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME`, `OA_CONFIG_JSON` (the rendered `config`) |
| `acp`, unsandboxed | the manifest's `env`, `OA_CONNECTOR_NAME`; never `OA_CORE_SOCKET` or `OA_CONFIG_JSON` |
| `acp`, `sandbox: bwrap` | after `--clearenv`: `PATH` (the host's, or `/usr/local/bin:/usr/bin:/bin`), `HOME=<work_dir>/home/<name>`, the manifest's `env`, `OA_CONNECTOR_NAME`; `LANG` and `OA_HOME` only when the base has them, which the daemon's default base does not |

Secrets are rendered into that environment at spawn and nowhere else; the SDK deletes
`OA_CONFIG_JSON` after reading it so subprocesses do not inherit it.

**Backoff.** A process that exits or fails to start is respawned after `min(restart.base
× 2^restarts, restart.max)` (defaults 1s and 60s); the counter resets after 30 s of
uptime (`STABLE_MS`). `connector.failed`, `connector.exited`, `connector.restart_scheduled`,
`connector.up` tell the story; `oa_connector_restarts_total{connector}` counts it.

**Health.** A `stdio` manifest with `health: {interval, timeout, failures}` gets an MCP
`ping` every `interval`; `failures` consecutive misses (no answer within `timeout`, or
an error) count as a crash: kill, respawn with backoff (`connector.unhealthy`,
`connector.health_failed`). `GET /v1/connectors` carries `health: {ok, checked_at,
failures}`; `ok` is `null` until the first check after a start.

**Restart.** `POST /v1/connectors/<name>/restart` kills the process (SIGTERM, 5 s,
SIGKILL), resets the counter, re-resolves the secrets and respawns; it is the step after
rotating a secret. 409 for a built-in (it re-resolves on every poll) and for a unit's
connector without ops (restart it with `systemctl`); a unit's `stdio` connector is
reconnected, which makes the host spawn a fresh process with fresh secrets.

**Reload.** `apply(manifests)` diffs by manifest key: added connectors are spawned,
removed ones stopped, changed ones respawned with freshly resolved secrets, unchanged
ones untouched; a changed `managed_by: systemd` manifest without ops cannot be applied
from the core and logs `connector.unit_restart_needed`. `configure(defaults.agent)`
restarts every sandboxed `acp` connector when `work_dir` changed, since they mount it.

**Status.** `ConnectorStatus` is `{name, transport, managed_by, sandbox, network, state,
pid, restarts, error, health}` with `state` in `starting | up | down | stopped |
external` and `network` in `host | none | allowlist`; `oa connector list` renders it.
Pollers appear with `builtin: "poller"`, `state: up` and no `health` key.

## A connector in its own unit

`managed_by: systemd` takes a process connector out of the supervisor. The template
unit `247-agent-connector@<name>.service` runs `247-agent-connector-host <name>`
(`host-main.ts`, `connectors/host.ts`), which reads the same `agent.yaml` and manifest,
refuses a connector not marked `managed_by: systemd` (so nothing runs twice), resolves
the connector's secrets from its own process environment (the unit's `LoadCredential=`
or `OA_SECRET_*`), builds the child environment with the same `connectorChildEnv`, and:

- `transport: none`: runs the process for the life of the unit with stdout and stderr
  inherited (journald), exits with the child's code when it dies on its own, turning a
  0 into 1 so `Restart=always` restarts it. The supervisor lists it as `external` and
  watches nothing.
- `transport: stdio`: listens on the manifest's `socket` (mode `0660`, the stale file
  removed unconditionally), and for every connection from the core spawns a fresh
  connector process, re-reading config and secrets, and bridges the socket to its
  stdin/stdout with MCP's line framing unchanged; a new connection replaces the old
  one, a closed one terminates the process. The supervisor connects through
  `connectors/socket-transport.ts` instead of spawning, with the usual backoff, health
  pings and `ops` allowlist.

The host logs JSON on stderr at `info` with `connector` on every line. The unit is
`PartOf=247-agent.service` and keeps `Group=247-agent`, which is how it reads
`/etc/247-agent` and reaches the core socket. The daemon never resolves such a
connector's secrets.

## The built-in poller

`connectors/poller.ts` turns any list op into an event source without a process. A
manifest with `builtin: poller` carries `config: {schedule, tz?, connector, op, args?,
timeout?, items?, item_key, event, first_run, keep}` (strict; the user table is in
`docs/connectors/poller.md`). Per tick:

1. A poll in flight → the tick is skipped (`poller.skipped`).
2. `args` templates are rendered fresh with `{secrets, env}`; secrets are resolved per
   poll and never kept on the instance, which is why a poller needs no restart after a
   rotation.
3. The target connector's op is called through the supervisor's client with the
   poller's `timeout` or the 60 s default; the manifest's `ops` applies.
4. `items` (JMESPath, default the whole result) must be an array; each `item_key` must be
   a non-empty string or a finite number.
5. In one store transaction: the seen list is read from state `<name>/seen` (a malformed
   value is ignored with `poller.seen_invalid`); every unseen key publishes `event` with
   `source: <name>`, `dedup_key: <name>:<key>` and the item as payload, except on the
   very first poll with `first_run: skip`, which only seeds the list (`poller.seeded`);
   the list becomes the previous keys not returned this time, then the current keys in
   result order, cut to the last `keep` (keys still returned move to the end, so older
   ones age out first).
6. `poller.polled {items, new, emitted, duplicates}` on success; any failure (connector
   down, op error, bad shape, bad key, missing secret) logs `poller.failed` and leaves
   the list untouched for the next tick.

The first poll is at the next cron boundary, not at start. Resetting the list
(`DELETE /v1/state/<name>/seen`) treats everything as new; the events' `dedup_key`
still drops true repeats.

## The SDK

`packages/connector-sdk/src/index.ts` has no local imports, so Node runs a connector
straight from TypeScript source; the test fixtures depend on that. The contract:

- `connectorEnv()` reads `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and `OA_CONFIG_JSON`
  (throws `… are not set (not started by the core?)` without the first two) and deletes
  `OA_CONFIG_JSON` from the environment.
- `CoreClient({socket, name, timeoutMs = 10_000})`: `emitEvent(input)` posts to
  `/v1/events` with `source: name`; `getState(key)` returns `undefined` on 404;
  `putState(key, value)`; errors are `CoreApiError` with `.status`.
- `defineTool({name, description?, input (zod raw shape), handler})`,
  `createConnectorServer({name, version, tools})` (an `McpServer`; a handler's return
  value becomes one JSON text block, a throw becomes `isError` with the message),
  `serveStdio(server)`.
- `runConnector({version?, setup?, tools})`: `connectorEnv()`, build the runtime
  `{env, core, log}` (`log` writes to stderr), `await setup(rt)`, build the server from
  `tools(rt)`, serve stdio. Every bundled `main.ts` is `await runConnector(…)` at module
  top level, so a throw anywhere in that sequence (invalid config, a failed `getMe` or
  `/myself`) exits the process with code 1 and the supervisor backs off.

Connectors in other languages implement the same three things: `POST /v1/events`,
`/v1/state`, MCP over stdio. `skills/247-agent-connectors/references/protocol.md` is the
language-neutral statement of it.

## Sandboxed agent programs

For an `acp` manifest with `sandbox: bwrap` the supervisor spawns `bwrap … -- <exec>`
once, for the life of the process (`actions/sandbox.ts`, `buildSandboxArgv`): `work_dir`
is the one writable path and holds every run's workspace and the program's home, the
manifest's `ro_binds`/`rw_binds` add the repositories, and the daemon's protected paths
are masked. With `sandbox.network` the supervisor also opens a filtering proxy per
connector on a Unix socket in `<socket>.net/` (`connectors/net-proxy.ts`), binds it
into the sandbox at `/tmp/.247-agent-net.sock`, and starts the agent behind an in-sandbox
bridge (`actions/sandbox-net.ts`) that exposes the proxy on loopback and sets
`HTTP_PROXY`/`HTTPS_PROXY`; `allow: []` gets neither proxy nor bridge, an empty network
namespace. The proxy lives as long as the process; a respawn gets a new one, and a
changed list is a changed manifest. What each sandbox hides and the allowlist rules are
in [`security.md`](security.md); the metrics are `oa_sandbox_net_requests_total`.

## The bundled connectors

| Connector | Wraps | Shape | Ops | State it writes |
|---|---|---|---|---|
| `email` | imapflow (IMAP), an own POP3 client, nodemailer (SMTP), mailparser | poll-style: a cron task calls `fetch_new` and fans out `email.received` | `fetch_new`, `mark_read`, `send` | `last_uid`, `uidvalidity` (IMAP), `seen_uidls` (POP3, capped at 20 000) |
| `ftp` | ssh2-sftp-client, basic-ftp | ops only, one connection per call, every path confined to `root`; `sync` is the one op that reads local disk, under `local_roots` | `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir`, `sync` (eight) | none |
| `chat` | Telegram Bot API, or the Matrix Client-Server API with `backend: matrix` | push-style: long polls and emits `chat.message` and `chat.reply`; `ask` stores the question | `send`, `ask` | `offset` (Telegram) or `since` (Matrix), `pending` |
| `webhook` | `node:http` | push-style, `transport: none`: one event per verified request | none | none |
| `github` | GitHub REST | ops only, confined to `repos`; list ops return `{repo, <items>: […]}` for the poller | 15 ops | none |
| `jira` | Jira REST v3 (Cloud, ADF converted) or v2 (Data Center) | ops only, confined to `projects`; JQL wrapped as `project in (…) AND (…)` | 8 ops | none |

Each `connectors/<name>/` is an npm workspace package with its zod `config.ts`, a
`main.ts` on `runConnector`, unit tests against fake transports, development notes in
its `README.md`, and for chat, email, ftp and webhook a `test/smoke/` module for the rig
([`testing.md`](testing.md)). The user pages under `docs/connectors/` are the
configuration reference. Event `source` is always the manifest name, so a manifest
named `mail` emits with `source: mail`.

The fakes in `packages/core/test/fixtures/` (`fake-email.ts`, `fake-ftp.ts`,
`fake-chat.ts`, `fake-mcp.ts`, `fake-plain.ts`, `fake-acp.ts`) keep the real ops' shapes,
so a tasks file tried against them runs unchanged against the real connectors.

## Invariants a change must keep

- A connector receives, at spawn, only the secrets its manifest names, in its
  environment; there is no secrets endpoint on the API.
- Only `acp` connectors may be sandboxed; everything else needs the socket.
- The manifest's `ops` is enforced before any call, for tasks and for agent bridges
  alike.
- A bundled connector is named by its launcher in manifests, bundled by
  `scripts/bundle.mjs`, and has a fake for the core's integration tests
  ([`howto/add-connector.md`](howto/add-connector.md)).
- Stdout of a `stdio` connector is the MCP channel; logging goes to stderr.
