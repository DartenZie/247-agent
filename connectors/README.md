# Connectors

Sub-programs the daemon spawns to talk to the outside world. A connector is any
executable with a manifest; it may **emit events** into the core (`POST /v1/events` on
the Unix socket) and/or **expose operations** as an MCP server on stdio, which
`connector` actions call and `agent` runs can receive as tools. Any language works;
existing MCP servers (GitHub, filesystem, …) are connectors as-is.

One npm workspace package per connector lives here (`connectors/*` in the root
`package.json`). Each has its own `README.md` with the config reference for its
manifest `config` block and the shape of its ops and events.

| Package | Status | Events | Ops |
|---|---|---|---|
| [`email`](email/README.md) | done | `email.received` (fanned out by a cron task) | `fetch_new`, `mark_read`, `send` |
| `chat` (Telegram or Matrix) | planned | `chat.message`, `chat.reply` | `send`, `ask` |
| `github`, `jira` | planned | via `poller` | their official MCP servers |
| `webhook` | planned | generic HTTP in | none |
| `poller` | planned, built into the core | one event per new item of any op | none |

Where things are documented:

- `docs/ARCHITECTURE.md` §6: the protocol, lifecycle and environment (source of truth).
- `docs/USER-GUIDE.md` §6: installing and configuring connectors on a server.
- `skills/247-agent-connectors/`: the step-by-step workflow, manifest and SDK
  references, a protocol reference for non-TypeScript connectors, and
  `assets/connector-template.ts` to start from.
- `packages/connector-sdk/src/index.ts`: `runConnector`, `defineTool`, `CoreClient`.
- `docs/examples/connectors.d/*.yaml`: example manifests; `oa validate` must keep
  passing on them.

## Rules that hold for every connector

- Read config from `OA_CONFIG_JSON`, never from files. Secrets are already rendered into
  it through `${secrets.<name>}` in the manifest and must never be logged.
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

## Adding a connector

1. Create `connectors/<name>/` with `package.json` (`@247-agent/connector-<name>`,
   `"type": "module"`, `"main": "dist/main.js"`, depends on
   `@247-agent/connector-sdk`) and a `tsconfig.json` that extends
   `../../tsconfig.base.json` and references `../../packages/connector-sdk`. Use
   `connectors/email` as the template.
2. Add `{ "path": "connectors/<name>" }` to the root `tsconfig.json` references so
   `npm run build` includes it.
3. Implement `src/main.ts` with `runConnector({ tools })` from the SDK, or in any other
   language following `skills/247-agent-connectors/references/protocol.md`.
4. Write `connectors/<name>/README.md`: the manifest, every `config` key with its
   default, each op's input and output, and the events it emits.
5. Add an example manifest under `docs/examples/connectors.d/<name>.yaml` and mention
   the connector in `docs/ARCHITECTURE.md` §6 and
   `skills/247-agent-connectors/references/manifest.md`.
6. Test without the network: unit tests next to the code as `*.test.ts` with fake
   servers or transports, and a fake connector under `packages/core/test/fixtures/` for
   the core's integration tests. Node runs a fake straight from TypeScript source when
   the manifest says `exec: [node, path/to/fake.ts]`.

```
npm install
npm run build
npm test
node packages/cli/dist/main.js validate docs/examples/connectors.d/<name>.yaml
```

Manifest changes need a daemon restart; SIGHUP reloads task files only. To debug a
connector by hand, run it with `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and
`OA_CONFIG_JSON` set and read its stderr. More symptoms and fixes are in the
`247-agent-connectors` skill.
