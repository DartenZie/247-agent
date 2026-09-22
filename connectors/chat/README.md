# Chat connector (Telegram)

A Telegram bot for the human-in-the-loop parts of a workflow. A push-style connector: it
long-polls the Bot API and emits every message from the configured chat as a
`chat.message` event; `send` posts a message; `ask` posts a question with inline buttons
(Approve / Reject by default) and emits the answer as a `chat.reply` event carrying the
`correlation_id` the asking task passed in, which is what a `wait` step matches on (see
`docs/examples/website-updates.yaml`, task `approve_general_change`).

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/chat.yaml
```

## Manifest

```yaml
name: chat
exec: ["node", "connectors/chat/dist/main.js"]
transport: stdio
emits: [chat.message, chat.reply]
ops: [send, ask]
config:
  backend: telegram                     # only telegram today (the key is here for a Matrix backend)
  token: "${secrets.chat_token}"        # the bot token from @BotFather
  chat_id: "${secrets.chat_id}"         # the chat the bot talks to: a number, or @channelname
  allowed_chat_ids: []                  # more chats whose messages are relayed; send/ask may target them
  poll_timeout: 30                      # getUpdates long-poll wait in seconds, 0..50 (0 = short polling)
  initial: none                         # first start with no stored offset: skip the backlog | `all` delivers it
  ask_options: [Approve, Reject]        # default buttons of `ask`; the first one means "approved"
  pending_limit: 200                    # unanswered questions remembered in state
  api_base: https://api.telegram.org    # only a local Bot API server changes this
  timeout: 30000                        # per Bot API call, ms (getUpdates adds poll_timeout on top)
```

`token` and `chat_id` are required; everything else has the default shown. Both come from
the secrets backend through `${secrets.<name>}`; the connector never logs them. Note that
`chat_id` is not a secret in the strict sense: it is the address messages come from, so it
appears in event payloads (`payload.chat_id`) and therefore in the database. Keeping it in
the secrets backend just keeps it out of the config files.

### Getting a token and a chat id

1. Talk to [@BotFather](https://t.me/BotFather) in Telegram, `/newbot`, follow the prompts.
   The reply contains the token (`123456789:AAF…`). Store it as `chat_token`.
2. Open a chat with the new bot and send it any message (in a group: add the bot to the
   group and write to it; bots see all group messages only when their privacy mode is off,
   `/setprivacy` in BotFather, otherwise only commands and replies to the bot).
3. Read the chat id from the update the message produced:

   ```
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[].message.chat.id'
   ```

   A private chat has a positive id, a group a negative one (`-100…` for supergroups). Store
   it as `chat_id`. Public channels can also be addressed as `@channelname`.

4. Make sure no webhook is set on the bot (`getUpdates` fails with a 409 while one is):
   `curl -s "https://api.telegram.org/bot<token>/deleteWebhook"`.

The bot polls only while the daemon runs. Messages sent while it was down are delivered on
the next start (Telegram keeps them for 24 hours), except on the very first start with
`initial: none`, which skips whatever accumulated before the connector existed.

### Security

- Only messages from `chat_id` and `allowed_chat_ids` are relayed; anything else is dropped
  and logged once per chat (`chat: ignoring message from chat <id> …`), so a stranger who
  finds the bot cannot inject events. `send`/`ask` refuse any other `chat_id` too.
- A `chat.reply` is only emitted for a question this connector asked: the button's
  `callback_data` carries a nonce that must match the stored question, and a text answer
  must be a Telegram reply to the question naming one of its options.
- Each question is answered once. The first answer removes it from state and the buttons
  from the message; later taps get "already answered". `dedup_key` on the event guards the
  core as well.
- The manifest's `ops` list is the boundary: an agent-facing copy of the manifest should
  list neither `send` nor `ask`.

## Ops

### `send({ text, parse_mode?, reply_to?, chat_id? })` → `{ message_id, chat_id }`

Posts `text` to `chat_id` (default: the configured one; otherwise it must be in
`allowed_chat_ids`). `parse_mode` is `HTML`, `Markdown` or `MarkdownV2` as Telegram defines
them (plain text when unset; with a parse mode, special characters in templated values must
be escaped by the task). `reply_to` is a `message_id` in the same chat to quote.

### `ask({ text, correlation_id?, options?, parse_mode?, reply_to?, chat_id? })` → `{ message_id, chat_id, options }`

Posts `text` with one inline button per option (`ask_options` when `options` is not given,
at most 20; up to three fit in one row) and stores the question under the connector's state
key `pending` (`"<chat_id>:<message_id>"` → `{ correlation_id, options, nonce, chat_id,
asked_at }`). The answer arrives as a `chat.reply` event (below). Pass
`correlation_id: ${event.correlation_id}` so the waiting task can match its own question.

Two ways to answer: tap a button, or reply to the question (Telegram's "Reply") with the
text of an option (case-insensitive, `approve` works). A reply that names no option is an
ordinary `chat.message` with `reply_to` set.

## Events

Both carry `source: chat` and a `dedup_key`, so a replayed update never produces a second
event.

### `chat.message`

Every text or captioned message in an allowed chat (edited messages are ignored).
`dedup_key: chat:message:<chat_id>:<message_id>`.

```json
{ "text": "Please also update the opening hours", "message_id": 812, "chat_id": "123456789",
  "from": { "id": 987, "name": "Miro P", "username": "miro" },
  "date": "2026-06-01T08:00:00.000Z", "reply_to": null }
```

`from.id` and `from.username` are null for anonymous senders (channel posts). A trigger
filter like `payload.from.username == 'miro'` or `payload.chat_id == '-100…'` narrows it.

### `chat.reply`

The answer to an `ask`. The event's own `correlation_id` is the one `ask` received, so the
reply threads under the run that asked, and `payload.correlation_id` repeats it for the
`wait` filter. `dedup_key: chat:reply:<chat_id>:<message_id>` (the question's id).

```json
{ "correlation_id": "cor_01J…", "approved": true, "choice": "Approve", "text": "Approve",
  "from": { "id": 987, "name": "Miro P", "username": "miro" },
  "message_id": 815, "chat_id": "123456789", "answer_message_id": null }
```

`approved` is true when the chosen option is the first one (`Approve` by default), so a
task with custom options like `[Deploy now, Tomorrow, Cancel]` gets `approved: true` for
`Deploy now` and reads `choice` for the rest. `text` is the button label, or the typed text
for a text reply, whose own id is then `answer_message_id`.

## Tasks

```yaml
- name: approve_change
  trigger: { kind: event, type: site.change_ready }
  action:
    kind: sequence
    steps:
      - kind: connector
        connector: chat
        op: ask
        args:
          text: "Site change ready: ${event.payload.summary}\nApprove?"
          correlation_id: ${event.correlation_id}
      - kind: wait
        for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
        timeout: 24h
        on_timeout: fail
      - kind: shell
        when: "steps[1].payload.approved == `true`"
        cmd: ["git", "push", "origin", "HEAD:main"]

- name: notify
  trigger: { kind: event, type_any: ["task.*.failed", budget.exceeded] }
  action:
    kind: connector
    connector: chat
    op: send
    args: { text: "[247-agent] ${event.type}: ${event.payload.error}" }

- name: echo                                   # any message in the chat triggers a task
  trigger: { kind: event, type: chat.message, filter: "starts_with(payload.text, '/status')" }
  action:
    kind: connector
    connector: chat
    op: send
    args: { text: "All good.", reply_to: ${event.payload.message_id} }
```

## State

| key | value |
|---|---|
| `offset` | the next `update_id` to ask Telegram for; written after every handled update, so a restart does not replay |
| `pending` | open questions, `"<chat_id>:<message_id>"` → `{ correlation_id, options, nonce, chat_id, asked_at }`, newest `pending_limit` kept |

`oa` can inspect both through `GET /v1/state/chat`. Deleting `offset` with `initial: all`
replays the last 24 hours of updates; the events are deduplicated, but answered questions
are gone from `pending`, so their taps only get "already answered".

An update whose handling fails (the core unreachable, for instance) is retried on the next
poll without advancing the offset; after three failed attempts it is skipped with a
`giving up on update` log line. Poll failures back off from 1s to 30s, or wait for
Telegram's `retry_after` on a 429.

## Development

```
connectors/chat/src/
  config.ts     zod schema and defaults
  telegram.ts   the Bot API over fetch: one POST per method, errors without the token
  updates.ts    pure: classify an update, callback_data codec, keyboard layout, option matching
  bot.ts        send, ask, the update handler and the poll loop over a narrow CoreLike port
  main.ts       runConnector: getMe at start (a bad token exits non-zero), the two ops
```

Tests run without the network: `test-helpers.ts` has a fake Bot API behind the injected
`fetch` (records every call, answers with defaults or scripted responses and failures) and
an in-memory core (`state`, `events` with `dedup_key`). `bot.test.ts` covers the ops, the
ask → reply flow for buttons and text replies, foreign chats, offset persistence and the
poll loop's backoff. To try the real thing by hand:

```
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=chat \
OA_CONFIG_JSON='{"token":"123:ABC","chat_id":123456789,"poll_timeout":5}' \
node connectors/chat/dist/main.js
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with
`{"name":"ask","arguments":{"text":"Deploy?","correlation_id":"cor_test"}}`), or point a
local `agent.yaml` at the built connector and use `oa run … --wait` on a task like the
`approve_change` above; `oa emit chat.reply` is not needed, the tap is.

`packages/core/test/fixtures/fake-chat.ts` is the fake for the core's integration test and
for trying task files without Telegram: `ask` answers itself after `delay_ms` with a
`chat.reply` of the same shape (approved unless `config.approve` is false), `send`
records the text in the `sent` state key.
