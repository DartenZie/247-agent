# Connectors

Sub-programs the daemon spawns to talk to the outside world. A connector is any
executable with a manifest; it may **emit events** into the core (`POST /v1/events` on
the Unix socket) and/or **expose operations** as an MCP server on stdio, which
`connector` actions call and `agent` runs can be handed as tools (`mcp_servers`). A third
kind, `transport: acp`, is an Agent Client Protocol agent that `agent` actions open
sessions on (`docs/examples/connectors.d/claude.yaml`). Any language works; existing
MCP servers (GitHub, filesystem, …) and ACP agents are connectors as-is.

One npm workspace package per connector lives here (`connectors/*` in the root
`package.json`). Each has its own `README.md` with the config reference for its
manifest `config` block and the shape of its ops and events.

| Package | Status | Events | Ops |
|---|---|---|---|
| [`email`](email/README.md) | done | `email.received` (fanned out by a cron task) | `fetch_new`, `mark_read`, `send` |
| [`ftp`](ftp/README.md) | done | none (a task fans `list` out, see its example) | `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir` over SFTP, FTP or FTPS, confined to a `root` |
| [`chat`](chat/README.md) | done (Telegram; Matrix planned behind `backend`) | `chat.message` (every message in the configured chat), `chat.reply` (the answer to an `ask`, with the `correlation_id`) | `send`, `ask` (inline Approve/Reject buttons or custom options) |
| [`webhook`](webhook/README.md) | done | one per verified request, per route: `<event>` or `<event>.<type header>` (`github.push`) | none (`transport: none`) |
| [`github`](github/README.md) | done (REST wrapper; GitHub's own MCP server documented as an alternative) | via `poller` | `list_pull_requests`, `get_pull_request(_diff)`, `list_issues`, `get_issue`, `list_comments`, `list_commits`, `list_workflow_runs`, `search_issues`, `create_issue`, `update_issue`, `add_comment`, `add_labels`, `remove_label`, `create_pull_request`, confined to `repos` |
| [`jira`](jira/README.md) | done (REST wrapper, Cloud or Data Center) | via `poller` | `search` (JQL), `get_issue`, `list_comments`, `create_issue`, `update_issue`, `add_comment`, `list_transitions`, `transition_issue`, confined to `projects` |
| `poller` | done, built into the core | one event per new item of any op | none |

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
   `npm run build` includes it, a launcher `bin/247-agent-connector-<name>` (copy one)
   and an entry in `scripts/bundle.mjs` so the release bundles it.
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

A changed manifest takes effect on `oa reload` (or SIGHUP): that connector is respawned
with the new manifest and freshly resolved secrets. To debug a
connector by hand, run it with `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and
`OA_CONFIG_JSON` set and read its stderr. More symptoms and fixes are in the
`247-agent-connectors` skill.
