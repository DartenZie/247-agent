# Chat connector (Telegram or Matrix)

A chat bot for the human-in-the-loop parts of a workflow, on Telegram (the default) or
Matrix (`backend: matrix`): every message in the configured chat becomes a `chat.message`
event, `send` posts, `ask` posts a question whose answer arrives as a `chat.reply` event
with the asking task's `correlation_id`. How to set up a bot, configure and use it, every
`config` key, op, event and state key:
[`docs/connectors/chat.md`](../../docs/connectors/chat.md). Example manifest:
[`docs/examples/connectors.d/chat.yaml`](../../docs/examples/connectors.d/chat.yaml).

## Development

```
connectors/chat/src/
  config.ts       zod schema and defaults, one branch per backend (backend defaults to telegram)
  telegram.ts     the Bot API over fetch: one POST per method, errors without the token
  updates.ts      pure: classify an update, callback_data codec, keyboard layout, option matching
  bot.ts          Telegram: send, ask, the update handler and the poll loop over a narrow CoreLike port
  matrix.ts       the Client-Server API over fetch: bearer token, errcode and retry_after_ms on errors
  matrix-bot.ts   Matrix: join, send, ask with keycap reactions, the event handler and the sync loop
  tools.ts        the two ops (zod inputs) over the Bot interface both backends implement
  main.ts         runConnector: getMe / whoami + join at start (a bad token ends the process), then tools.ts
```

Tests run without the network: `test-helpers.ts` has a fake Bot API behind the injected
`fetch` (records every call, answers with defaults or scripted responses and failures)
and an in-memory core (`state`, `events` with `dedup_key`). `bot.test.ts` covers the ops,
the ask → reply flow for buttons and text replies, answers from users not in `approvers`, foreign chats, offset persistence and
the poll loop's backoff. `matrix-bot.test.ts` does the same for Matrix against a fake
homeserver behind `fetch`: alias resolution, reactions and text replies as answers,
ignored edits and encrypted rooms, the `since` cursor, a limited timeline's gap filled from `/messages`, a rejected
`since` token, a retried batch and the 429 wait. `tools.test.ts` lists the registered tools over an in-memory MCP transport and checks their names against the `ops` of `docs/examples/connectors.d/chat.yaml`.
The Matrix backend also runs against a real Synapse in the smoke rig (Telegram has no
server one can run):

```
npm run smoke:connectors -- chat       # test/smoke/compose.yaml + smoke.mjs
```

To try the real thing by hand:

```
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=chat \
OA_CONFIG_JSON='{"token":"123:ABC","chat_id":123456789,"poll_timeout":5}' \
bin/247-agent-connector-chat
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with
`{"name":"ask","arguments":{"text":"Deploy?","correlation_id":"cor_test"}}`), or point a
local `agent.yaml` at the built connector and use `oa run … --wait` on an approval task;
`oa emit chat.reply` is not needed, the tap is.

`packages/core/test/fixtures/fake-chat.ts` is the fake for the core's integration test
and for trying task files without Telegram: `ask` answers itself after `delay_ms` with a
`chat.reply` of the same shape (approved unless `config.approve` is false), `send` records
the text in the `sent` state key.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/chat.yaml
```
