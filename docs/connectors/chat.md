# Chat: Telegram or Matrix

The chat connector is a bot for the human-in-the-loop parts of a workflow: it tells you
what happened, and it asks you before anything high-impact is published. It runs on
Telegram by default, or on Matrix with `backend: matrix`. It is a **push-style**
connector: it long-polls the chat service and emits every message in the configured chat
as a `chat.message` event. `send` posts a message; `ask` posts a question with options and
emits the answer as a `chat.reply` event carrying the correlation id the asking task
passed in, which is what a [`wait`](../tasks/wait.md) step matches on. Ops and events
are the same on both backends, so a task file does not change when the backend does.

## Set up Telegram

1. **Create the bot.** Talk to [@BotFather](https://t.me/BotFather), send `/newbot` and
   follow the prompts. The reply contains the token (`123456789:AAF…`). Store it as the
   secret `chat_token`.
2. **Find the chat id.** Open a chat with the new bot and send it any message. In a
   group, add the bot and write to it; bots see all group messages only with privacy
   mode off (`/setprivacy` in BotFather), otherwise only commands and replies to the
   bot. Then read the id from the update your message produced:

   ```sh
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[].message.chat.id'
   ```

   A private chat has a positive id, a group a negative one (`-100…` for supergroups).
   Store it as `chat_id`; a public channel can also be addressed as `@channelname`.
3. **Make sure no webhook is set** on the bot, since polling fails with a 409 while one
   is: `curl -s "https://api.telegram.org/bot<token>/deleteWebhook"`.

The bot polls only while the daemon runs. Messages sent while it was down are delivered
on the next start (Telegram keeps them for 24 hours), except on the very first start with
`initial: none`, which skips whatever accumulated before the connector existed.

## Set up Matrix

1. **Register a user for the bot** on your homeserver (Synapse:
   `register_new_matrix_user`, or any client) and invite it to the room your workflows
   use. At start the connector joins every configured room, which accepts the invite and
   resolves aliases.
2. **Log in once for an access token** and store it as `chat_token`:

   ```sh
   curl -s -XPOST https://matrix.example.org/_matrix/client/v3/login \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"bot"},"password":"…","initial_device_display_name":"247-agent"}' | jq -r .access_token
   ```

   Do not log that device out: it invalidates the token.
3. **Find the room id** under the room's settings → Advanced in Element
   (`!AbCdEf:example.org`); an alias such as `#ops:example.org` works too.

> [!WARNING]
> The room must not be end-to-end encrypted. The connector speaks the plain Client-Server
> API and ignores an encrypted room after logging it once. Use an unencrypted room on a
> homeserver you run; messages to and from the bot then stay on that server.

## Manifest

```yaml
name: chat
exec: ["247-agent-connector-chat"]
transport: stdio
emits: [chat.message, chat.reply]
ops: [send, ask]
config:
  backend: telegram                     # telegram (default) | matrix
  token: "${secrets.chat_token}"        # the bot token from BotFather
  chat_id: "${secrets.chat_id}"         # the chat the bot talks to: a number, or @channelname
  allowed_chat_ids: []                  # more chats whose messages are relayed; send/ask may target them
  poll_timeout: 30                      # long-poll wait in seconds, 0..50
  initial: none                         # first start with no stored cursor: skip the backlog | all
  ask_options: [Approve, Reject]        # default options of ask; the first one means "approved"
  pending_limit: 200                    # unanswered questions remembered
  api_base: https://api.telegram.org    # only a local Bot API server changes this
  timeout: 30000                        # per API call, ms
```

The same connector on Matrix:

```yaml
name: chat
exec: ["247-agent-connector-chat"]
transport: stdio
emits: [chat.message, chat.reply]
ops: [send, ask]
config:
  backend: matrix
  homeserver: https://matrix.example.org   # the client API base of the bot's homeserver
  token: "${secrets.chat_token}"           # the bot user's access token
  chat_id: "!AbCdEf:example.org"           # a room id, or an alias like "#ops:example.org"
  allowed_chat_ids: []
  poll_timeout: 30                         # /sync wait in seconds, 0..120
  initial: none
  ask_options: [Approve, Reject]           # at most 10 on Matrix
  pending_limit: 200
  timeout: 30000
```

> [!WARNING]
> Quote Matrix room ids and aliases in YAML: `!` and `#` are YAML syntax.

`chat_id` is not a secret in the strict sense: it is the address messages come from, so
it appears in event payloads and therefore in the database. Keeping it in the secrets
backend just keeps it out of the config files.

### Config keys

Both backends:

| Key | Default | Meaning |
|---|---|---|
| `backend` | `telegram` | `telegram` or `matrix` |
| `token` | required | the bot token or the Matrix access token |
| `chat_id` | required | Telegram: a numeric id or `@channelname`. Matrix: a room id `!…:server` or alias `#…:server` |
| `allowed_chat_ids` | `[]` | more chats or rooms whose messages are relayed; `send` and `ask` may target them |
| `initial` | `none` | on the first start with no stored cursor, `none` skips the backlog, `all` delivers it |
| `ask_options` | `[Approve, Reject]` | the options of an `ask` without its own; the first means "approved". 1 to 20 on Telegram, 1 to 10 on Matrix |
| `pending_limit` | `200` | how many unanswered questions are kept in state, newest first |
| `timeout` | `30000` | per API call, in milliseconds; a long poll adds `poll_timeout` on top |

Telegram only: `poll_timeout` (`30`, 0 to 50 seconds; 0 is short polling) and `api_base`
(`https://api.telegram.org`). Matrix only: `homeserver` (required) and `poll_timeout`
(`30`, 0 to 120 seconds).

## Ops

### `send`

```yaml
args: { text: "Published: ${event.payload.summary}", parse_mode: HTML, reply_to: "${event.payload.message_id}" }
```

Posts `text` to the configured chat, or to a `chat_id` from `allowed_chat_ids`. Result
`{ message_id, chat_id }`. `parse_mode` is `HTML`, `Markdown` or `MarkdownV2`; plain text
when unset. With a parse mode, special characters in templated values must be escaped by
the task. `reply_to` quotes a message: a message id on Telegram, an event id (`$…`) on
Matrix; the wrong kind is refused. On Matrix, `HTML` becomes the room's formatted body
with a tag-stripped plain text; the Markdown modes are sent as typed.

### `ask`

```yaml
args:
  text: "Site change ready: ${event.payload.summary}\nApprove?"
  correlation_id: ${event.correlation_id}
  options: [Approve, Reject]          # optional; ask_options otherwise
```

Posts the question with its options and remembers it in state under the connector's
`pending` key. Result `{ message_id, chat_id, options }`. The answer arrives later as a
`chat.reply` event. Pass `correlation_id: ${event.correlation_id}` so the waiting task can
match its own question.

- **Telegram** shows one inline button per option (up to three in a row). Tap one, or
  reply to the question with the text of an option, case-insensitively.
- **Matrix** has no buttons. The question lists `1️⃣ Approve`, `2️⃣ Reject`, … and the bot
  reacts to its own message with those keycaps, so answering is one tap on a reaction.
  Replying to the question (or in its thread) with an option's text, its number or its
  keycap answers too. At most 10 options.

Each question is answered once: the first answer removes it from state and the buttons
from the message, and the bot confirms with `Recorded: <choice>`. Later taps get "already
answered".

## Events

Both events carry a `dedup_key`, so a replayed update never produces a second event.
The event's `source` is the manifest's `name`.

### `chat.message`

Every text or captioned message in an allowed chat. Edited messages, notices from other
bots and the bot's own messages are ignored. `dedup_key: chat:message:<chat_id>:<message_id>`.

```json
{ "text": "Please also update the opening hours", "message_id": 812, "chat_id": "123456789",
  "from": { "id": 987, "name": "Miro P", "username": "miro" },
  "date": "2026-06-01T08:00:00.000Z", "reply_to": null }
```

`from.id` and `from.username` are `null` for anonymous senders such as channel posts. On
Matrix, ids are strings: `message_id` and `reply_to` are event ids, `chat_id` is the room
id (also when the config names an alias), `from.id` and `from.username` are the user id
and `from.name` the display name. A reply that answers an open question is not a
`chat.message`; it becomes the `chat.reply` below.

### `chat.reply`

The answer to an `ask`. The event's own `correlation_id` is the one `ask` received, so
the reply threads under the run that asked, and `payload.correlation_id` repeats it for
the `wait` filter. `dedup_key: chat:reply:<chat_id>:<question message_id>`.

```json
{ "correlation_id": "cor_01J…", "approved": true, "choice": "Approve", "text": "Approve",
  "from": { "id": 987, "name": "Miro P", "username": "miro" },
  "message_id": 815, "chat_id": "123456789", "answer_message_id": null }
```

`approved` is true when the chosen option is the first one, so with custom options such
as `[Deploy now, Tomorrow, Cancel]` you get `approved: true` for `Deploy now` and read
`choice` for the rest. `text` is the option label, or the typed text of a reply, whose own
id is then `answer_message_id`.

## Security

- Only messages from `chat_id` and `allowed_chat_ids` are relayed; anything else is
  dropped and logged once per chat, so a stranger who finds the bot cannot inject events.
  `send` and `ask` refuse any other target too.
- A `chat.reply` is emitted only for a question this connector asked, and only once.
- The manifest's `ops` list is the boundary: a copy of the manifest for an agent should
  list neither `send` nor `ask`.

## Tasks

An approval gate and a notifier:

```yaml
tasks:
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
          cwd: ${event.payload.worktree}
          cmd: ["git", "push", "origin", "HEAD:main"]

  - name: notify
    trigger: { kind: event, type_any: ["task.*.failed", budget.exceeded] }
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "[247-agent] ${event.type}: ${event.payload.error || event.payload.summary}" }

  - name: status
    trigger: { kind: event, type: chat.message, filter: "starts_with(payload.text, '/status')" }
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "All good.", reply_to: "${event.payload.message_id}" }
```

> [!TIP]
> Match the reply on `correlation_id`, never on "the next reply". Two questions can be
> open at once.

## State

| Key | Backend | Value |
|---|---|---|
| `offset` | Telegram | the next update id to ask for; written after every handled update, so a restart does not replay |
| `since` | Matrix | the sync token; written after every handled batch |
| `pending` | both | the open questions, newest `pending_limit` kept, with their options and correlation id |

Inspect them with `GET /v1/state/chat`. Deleting `offset` with `initial: all` replays the
last 24 hours of Telegram updates; the events are deduplicated, but answered questions
are gone from `pending`, so their taps only get "already answered". An update whose
handling fails (the daemon unreachable, for instance) is retried on the next poll; after
three attempts it is skipped with a log line. Poll failures back off from 1 s to 30 s, or
wait as long as the service asks on a rate limit. A Matrix room with more than 50 new
events between two syncs logs that the older ones were skipped.
