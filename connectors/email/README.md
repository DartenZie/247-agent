# Email connector

IMAP or POP3 in, SMTP out. A poll-style connector: it emits nothing by itself; a cron
task calls `fetch_new` and fans the result out as `email.received` events (see
`docs/examples/website-updates.yaml`). `send` appends the configured footer to every
outgoing mail.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/email.yaml
```

## Manifest

```yaml
name: email
exec: ["node", "connectors/email/dist/main.js"]
transport: stdio
emits: [email.received]
ops: [fetch_new, mark_read, send]       # drop `send` for an agent-facing, read-only copy
config:
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming:
    protocol: imap                      # imap (default) | pop3
    host: imap.example.com
    port: 993                           # default: 993/995 with TLS, 143/110 without
    secure: true                        # implicit TLS; default true unless port is a plain one
    starttls: true                      # on a plain port, require STARTTLS/STLS before login
    reject_unauthorized: true           # verify the server certificate
    folder: INBOX                       # IMAP only
    initial: none                       # first fetch with no cursor: `none` | `all`
    limit: 50                           # max messages per fetch_new
    max_body_chars: 100000              # `body` is cut here
    delete_after_fetch: false           # POP3 only
    user: ...                           # optional per-side override
    password: ...
  outgoing:
    host: smtp.example.com
    port: 465                           # default: 465 with TLS, 587 without (STARTTLS)
    from: "Example Team <info@example.com>"
    footer: |                           # appended to the text body after a blank line
      --
      Example Team office
    footer_html: "<p>…</p>"             # appended to the html body; derived from `footer` when unset
```

`incoming` and `outgoing` are each optional (receive-only or send-only), one of them is
required. Credentials come from the secrets backend through `${secrets.<name>}`; the
connector never logs them.

## Ops

### `fetch_new({ folder?, since_uid?, limit? })` → `{ emails, last_uid }`

- **IMAP**: `since_uid` is the UID cursor; messages with a higher UID come back in UID
  order, at most `limit`. When `since_uid` is absent the connector's own state entry
  `last_uid` is used. `UIDVALIDITY` is tracked; when the server changes it the cursor is
  reset and the mailbox is treated as new.
- **POP3**: there is no cursor. The connector remembers the UIDLs it delivered in its
  state (`seen_uidls`, pruned to what is still on the server) and returns the ones it has
  not seen. `since_uid` is ignored; `last_uid` is the last delivered UIDL.
- The first call with no cursor and `initial: none` marks everything already in the
  mailbox as seen and returns nothing. `initial: all` delivers it, `limit` at a time.

Each item of `emails`:

```json
{ "uid": 42, "message_id": "<m1@example.com>", "from": "editor@example.com",
  "from_name": "Editor", "to": ["info@example.com"], "cc": [], "reply_to": null,
  "subject": "Spring event", "date": "2026-06-01T08:00:00.000Z",
  "body": "Please add it.", "truncated": false,
  "in_reply_to": null, "references": [],
  "attachments": [{ "filename": "programme.pdf", "content_type": "application/pdf", "size": 12345 }] }
```

`from` is the bare lower-cased address, so a trigger filter like
`payload.from == 'editor@example.com'` works. `body` is the text part, or a plain-text
rendering of an HTML-only mail. Attachment contents are not fetched. A missing
`Message-ID` is replaced by a hash of the raw message so `dedup_key` stays usable.

### `mark_read({ folder?, uid? | message_id? })` → `{ ok, supported }`

Sets `\Seen` on one message. IMAP only; POP3 returns `{ ok: false, supported: false }`.

### `send({ to, cc?, bcc?, subject, text?, html?, reply_to?, in_reply_to?, references?, attachments? })` → `{ message_id, accepted, rejected }`

Sends from `outgoing.from`. `text` gets `footer` appended after one blank line; `html`
gets `footer_html` (or the escaped text footer) before `</body>`. `in_reply_to` is also
added to `References` so replies thread. `attachments` are
`{ filename, content, encoding?: utf8|base64, content_type? }`; content only, no paths.

## Examples

`examples/` holds two ready-to-validate task files, both using the manifest from
`docs/examples/connectors.d/email.yaml`:

- `auto-reply.yaml` — poll the mailbox, acknowledge each new message in-thread, mark it
  read. Fully deterministic.
- `daily-digest.yaml` — a second, independent cursor on the same mailbox; one digest mail
  per weekday morning, plus an optional single Haiku call for prose.

## Tasks

```yaml
- name: fetch_email
  trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }
  action:
    kind: connector
    connector: email
    op: fetch_new
    args: { since_uid: "${state.email.last_uid}" }
  state_updates: { email.last_uid: "${result.last_uid}" }
  emit:
    - type: email.received
      each: ${result.emails}
      dedup_key: "email:${item.message_id}"
      payload: ${item}

- name: reply
  trigger: { kind: event, type: request.answer_ready }
  action:
    kind: connector
    connector: email
    op: send
    args:
      to: "${event.payload.email.from}"
      subject: "Re: ${event.payload.email.subject}"
      in_reply_to: "${event.payload.email.message_id}"
      references: ${event.payload.email.references}
      text: "${event.payload.answer}"
```

## Development

Tests run without the network: `pop3.test.ts` starts a fake POP3 server in-process,
`imap.test.ts` drives `ImapMailbox` with a fake client, `send.test.ts` renders through
nodemailer's stream transport. STLS/STARTTLS upgrades are not covered by tests.
`packages/core/test/fixtures/fake-email.ts` stays the fake for the core's integration
test; it returns the same shape as `fetch_new`.
