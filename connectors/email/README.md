# Email connector

IMAP or POP3 in, SMTP out. A poll-style connector: it emits nothing by itself; a cron
task calls `fetch_new` and fans the result out as `email.received` events. How to
configure and use it, every `config` key, op and state key:
[`docs/connectors/email.md`](../../docs/connectors/email.md). Example manifest:
[`docs/examples/connectors.d/email.yaml`](../../docs/examples/connectors.d/email.yaml).

## Development

```
connectors/email/src/
  config.ts   zod schema: top-level user/password, incoming (imap | pop3) and outgoing (smtp) endpoints, port and TLS defaults
  types.ts    EmailMessage, the op shapes
  parse.ts    mailparser → EmailMessage: bare lower-cased addresses, body cut at max_body_chars, hashed Message-ID fallback
  imap.ts     imapflow: UID cursor, UIDVALIDITY tracking, initial: none | all, mark_read
  pop3.ts     own POP3 client: UIDL-based "seen" list (max 20 000), STLS, delete_after_fetch
  send.ts     nodemailer: footer and footer_html, in_reply_to → References, attachments from content
  main.ts     runConnector: the three ops; no network call at start
```

Tests run without the network: `pop3.test.ts` starts a fake POP3 server in-process,
`imap.test.ts` drives the mailbox with a fake client, `send.test.ts` renders through
nodemailer's stream transport. STARTTLS and STLS upgrades are not covered by the unit
tests; the smoke rig covers them against real servers:

```
npm run smoke:connectors -- email      # GreenMail + a Dovecot STARTTLS proxy in podman (test/smoke/)
```

`packages/core/test/fixtures/fake-email.ts` is the fake for the core's integration test
and for trying task files without a mailbox; it returns the same shape as `fetch_new`
from the `mails` in its manifest `config`.

`examples/` holds two ready-to-validate task files, both for the manifest in
`docs/examples/connectors.d/email.yaml`: `auto-reply.yaml` acknowledges each new message
in-thread and marks it read; `daily-digest.yaml` keeps a second cursor on the same mailbox
for one digest per weekday morning, with an optional Haiku call for prose. Note that a
`fetch_new` `limit` argument is capped by the manifest's `incoming.limit` (default 50).

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/email.yaml connectors/email/examples/*.yaml
```
