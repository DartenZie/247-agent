---
name: 247-agent-connectors
description: "Build, configure and debug 247-agent connectors, the sub-programs the daemon spawns to emit events (email, chat, webhooks, pollers) and to expose operations as MCP tools. Use it whenever the user wants to connect the daemon to an external system (IMAP, SMTP, Telegram, Matrix, GitHub, Jira, a webhook, any existing MCP server), write or edit a manifest under `connectors.d/` or the `connectors:` list of `agent.yaml`, use `@247-agent/connector-sdk` (`runConnector`, `defineTool`, `CoreClient`), write a fake connector for tests, or asks why a `connector` action fails, an op is \"not allowed\", or a connector keeps restarting."
---

# 247-agent connectors

A connector is any executable with a manifest. It may do one or both of:

- **emit events** into the core (`POST /v1/events` on the Unix socket), and
- **expose operations** as an MCP server on stdio, which the core calls from
  `connector` actions and can hand to `agent` runs as tools.

Any language works: the protocol is two HTTP calls and MCP over stdio
(`references/protocol.md`). TypeScript connectors use the SDK (`references/sdk.md`).
Existing MCP servers (GitHub, filesystem, …) are connectors as-is with
`transport: stdio`.

## Workflow

1. **Pick the shape.**
   - Poll-style (mailbox, API): expose a `fetch_new`-like op that takes a cursor and
     returns `{items, cursor}`. Let a cron task call it and fan out with `emit … each`
     and a `dedup_key`. The connector itself emits nothing. This keeps polling,
     dedup and routing in the core, which is where they are observable.
   - List-style (an op that returns what exists now: open PRs, unread messages): no
     code at all. Add a `builtin: poller` manifest that calls the op on a cron, keys
     items with `item_key` and emits one event per new key (`references/manifest.md`).
     This is how an off-the-shelf MCP server becomes a trigger.
   - Push-style (chat bot, webhook): emit events from the process as they arrive, with a
     `dedup_key` (message id) and, for replies to a question, the `correlation_id` the
     asking task passed in.
   - Ops-only (send mail, post a message): just tools.
2. **Write the manifest** (`references/manifest.md`): `name`, `exec`, `transport`,
   `emits`, `ops` allowlist, `config` with `${secrets.<name>}` for credentials.
3. **Implement it.** TypeScript: start from `assets/connector-template.ts` and the SDK
   reference. Other languages: `references/protocol.md`. Rules that hold in any
   language:
   - Read config from `OA_CONFIG_JSON`, never from files; secrets are already rendered
     into it and must not be logged.
   - Keep cursors and other state in the core (`GET|PUT /v1/state/<name>/<key>`) so the
     process stays stateless and restart-safe.
   - Log to **stderr** (the core records it as `connector.output`); stdout is the MCP
     channel when `transport: stdio`. A stray `console.log` breaks the protocol.
   - Return JSON-serialisable results; throw to signal an op error (becomes `isError`,
     which fails the calling run without retry).
   - Exit non-zero on unrecoverable errors; the supervisor restarts with backoff.
4. **Test it without the network.** Write a fake next to the real one, or reuse
   `packages/core/test/fixtures/fake-*.ts` (email, chat, generic MCP, plain emitter).
   Node runs a connector straight from TypeScript source when the manifest says
   `exec: [node, path/to/connector.ts]`, which is how the integration test does it.
5. **Validate and run.**

   ```
   oa validate connectors.d/<name>.yaml agent.yaml
   # start the daemon, then:
   oa run <task that calls the op> --wait
   ```

   Manifest changes need a daemon restart (SIGHUP reloads tasks files only); a rotated
   secret needs only `oa connector restart <name>`.

## Debugging

| Symptom | Cause and fix |
|---|---|
| run fails "op … not allowed" | The op is not in the manifest's `ops`. Add it, or use `ops: []` for any. |
| run fails with the tool's error text, no retry | The handler threw or returned `isError`. Fix the handler; the run is not retried on purpose. |
| run fails "connector … is down", retried | The process is not up. Check `connector.output` lines in the daemon log; look for a crash loop with growing backoff. |
| connector restarts every few seconds | It exits or crashes at start. Run it by hand with `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and `OA_CONFIG_JSON` set and read stderr. |
| MCP handshake errors | Something wrote to stdout. Route all logging to stderr. |
| Events never arrive | Check the emitting `POST /v1/events` response: `201` inserted, `200` duplicate by `dedup_key`. Check `type` matches the trigger and any `filter`. |
| Secret is empty in config | `${secrets.x}` in the manifest, but the backend has no `x`. See the `247-agent-config` skill. |

Source of truth: `docs/ARCHITECTURE.md` §6, `docs/USER-GUIDE.md` §6,
`packages/connector-sdk/src/index.ts`.
