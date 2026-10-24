# Email

The email connector reads a mailbox over IMAP or POP3 and sends mail over SMTP. It is a
**poll-style** connector: it emits nothing by itself. A cron task calls its `fetch_new`
op every few minutes and fans the new messages out as `email.received` events, which is
how the [reference workflow](../recipes/website-from-email.md) starts. `send` posts a
reply, with your footer appended.

## Set it up

You need a mailbox the daemon may read, and usually the same account to send from.

1. **Create or pick the account.** A dedicated mailbox is easier to reason about than
   your own inbox: the first fetch marks everything already there as seen, and every
   later message becomes an event.
2. **Get the credentials.** Most providers want an app-specific password rather than
   your login password when a program connects over IMAP (Gmail: Google Account →
   Security → App passwords; Fastmail, iCloud and Outlook have the same under their
   security settings). Note the IMAP and SMTP host names from the provider's help page.
3. **Store them as secrets.** With the `env` backend that is two variables in the
   daemon's environment:

   ```sh
   OA_SECRET_EMAIL_USER=info@example.com
   OA_SECRET_EMAIL_PASS=xxxx-xxxx-xxxx-xxxx
   ```

   With systemd credentials, one `LoadCredential=` line per name. See
   [Production](../operations/production.md).

4. **Write the manifest** below into `connectors.d/email.yaml` and run
   `oa validate agent.yaml`.

## Manifest

```yaml
name: email
exec: ["247-agent-connector-email"]
transport: stdio
emits: [email.received]
ops: [fetch_new, mark_read, send]       # drop `send` on a copy you hand to an agent
config:
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming:
    protocol: imap                      # imap (default) | pop3
    host: imap.example.com
    port: 993                           # default: 993/995 with TLS, 143/110 without
    secure: true                        # implicit TLS; see the table for the default
    starttls: true                      # on a plain port, require STARTTLS before login
    reject_unauthorized: true           # verify the server certificate
    folder: INBOX                       # IMAP only
    initial: none                       # first fetch with no cursor: skip what is there | all
    limit: 50                           # most messages one fetch_new returns
    max_body_chars: 100000              # body is cut here
    authserv_id: mx.example.com         # whose Authentication-Results fill `auth`
    delete_after_fetch: false           # POP3 only
  outgoing:
    host: smtp.example.com
    port: 465                           # default: 465 with TLS, 587 without (STARTTLS)
    from: "Example Team <info@example.com>"
    footer: |
      --
      Example Team office
```

`incoming` and `outgoing` are each optional, but one of them is required. `user` and
`password` at the top level apply to both sides; either side may set its own.

### Config keys

Shared by `incoming` and `outgoing`:

| Key | Default | Meaning |
|---|---|---|
| `host` | required | the server's host name |
| `port` | derived | 993 (IMAP), 995 (POP3) or 465 (SMTP) when `secure` is true; 143, 110 or 587 otherwise |
| `secure` | derived | implicit TLS from the first byte. With no `port`, true. With a `port`, true only for 993, 995 and 465; any other port defaults to plain |
| `starttls` | `true` | on a plain connection, require STARTTLS (STLS on POP3) before logging in |
| `reject_unauthorized` | `true` | verify the server's certificate |
| `user`, `password` | the top-level values | per-side override. Login happens only when both are set |

`incoming` only:

| Key | Default | Meaning |
|---|---|---|
| `protocol` | `imap` | `imap` or `pop3` |
| `folder` | `INBOX` | IMAP only; the `folder` argument of an op overrides it |
| `initial` | `none` | what the first `fetch_new` without a cursor does: `none` marks everything present as seen and returns nothing; `all` returns it, `limit` at a time |
| `limit` | `50` | the most messages one `fetch_new` returns, 1 to 1000. An op's own `limit` argument can only lower it |
| `max_body_chars` | `100000` | `body` is cut at this length; `truncated` says so |
| `authserv_id` | none | one name or a list: the authserv-id your receiving mail server writes into `Authentication-Results`. Only those headers fill `auth`; with none set, every result in `auth` is `none`. See [Trust the sender](#trust-the-sender) |
| `delete_after_fetch` | `false` | POP3 only: delete each message from the server once a later `fetch_new` passes its batch's `last_uid` back, so only after the run that got it succeeded |

`outgoing` only:

| Key | Default | Meaning |
|---|---|---|
| `from` | required | the `From:` header, `Name <address>` or a bare address |
| `footer` | none | appended to every text body after one blank line |
| `footer_html` | derived from `footer` | appended to every HTML body before `</body>`; set it to control the markup |

> [!WARNING]
> A `port` other than 993, 995 or 465 makes `secure` default to false. For a provider that
> uses TLS on an unusual port, set `secure: true` explicitly.

## Ops

### `fetch_new`

```yaml
action:
  kind: connector
  connector: email
  op: fetch_new
  args: { folder: INBOX, since_uid: "${state.email.last_uid}", limit: 50 }
```

Arguments: `folder` (IMAP only), `since_uid` (the cursor; `null` on the first run),
`limit` (at most the configured `limit`). Result: `{ emails, last_uid }`.

The cursor belongs to your task. Store `last_uid` with `state_updates` and pass it back
as `since_uid` on the next run. `state_updates` are written only when the run succeeds,
so after a failed run the next call passes the old cursor and gets the same mail again.
The connector keeps no cursor of its own: a missing or `null` `since_uid` means "no
cursor", and `initial` decides what comes back.

- **IMAP** uses UIDs as the cursor: messages with a UID above `since_uid` come back in
  UID order. If the server changes its `UIDVALIDITY`, the cursor resets and the mailbox
  is treated as new.
- **POP3** has no ordered identifiers, so the connector remembers which ones were
  handled. `last_uid` is the identifier of the last message in the batch. When the next
  call passes it back as `since_uid`, the connector records the batch as handled and,
  with `delete_after_fetch`, deletes it on the server. Any other `since_uid` delivers the
  batch again. One task polls a POP3 mailbox: a second task with its own cursor would
  confirm or redeliver the first task's batches.

Each entry of `emails`:

```json
{ "uid": 42, "message_id": "<m1@example.com>", "from": "editor@example.com",
  "from_name": "Editor", "to": ["info@example.com"], "cc": [], "reply_to": null,
  "subject": "Spring event", "date": "2026-06-01T08:00:00.000Z",
  "body": "Please add it.", "truncated": false,
  "in_reply_to": null, "references": [],
  "auth": { "authserv_id": "mx.example.com", "dkim": "pass", "dkim_domains": ["example.com"],
            "spf": "pass", "dmarc": "pass" },
  "attachments": [{ "filename": "programme.pdf", "content_type": "application/pdf", "size": 12345 }] }
```

`from` is the bare, lower-cased address, so a trigger filter such as
`payload.from == 'editor@example.com'` works. `body` is the text part, or a plain-text
rendering of an HTML-only mail. Attachment contents are never fetched, only their names
and sizes. A message without a `Message-ID` gets one derived from a hash of the message,
so a `dedup_key` built from it still works. `auth` holds the sender authentication
results; [Trust the sender](#trust-the-sender) explains them.

### Trust the sender

Anyone can write any address into `From:`. A filter on `payload.from` alone lets a
forged mail through. Your receiving mail server checks the sender when the mail arrives
and records the outcome in an `Authentication-Results` header. `auth` reports that
outcome:

| Field | Meaning |
|---|---|
| `authserv_id` | the trusted server the results come from; `null` when the mail has no header from it |
| `dkim` | `pass` when any DKIM signature verified, otherwise the first DKIM result |
| `dkim_domains` | the domains (`header.d`, else `header.i`) of the signatures that verified |
| `spf` | the SPF result for the envelope sender. `none` when the header holds more than one SPF result |
| `dmarc` | the DMARC result, if the header holds exactly one and it names the domain of `from` (`header.from`); otherwise `none` |

A result is one of the words the server wrote, in lower case: `pass`, `fail`,
`softfail`, `neutral`, `none`, `temperror` or `permerror`. A method the server did not
report is `none`.

Require `dmarc` in the filter. A DMARC pass means a DKIM signature or the SPF check
passed for the domain in `From:`. A DKIM pass alone can come from the sender's own
domain, not the one in `From:`.

```yaml
trigger:
  kind: event
  type: email.received
  filter: "payload.from == 'editor@example.com' && payload.auth.dmarc == 'pass'"
```

To set it up:

1. Open the raw source of a mail that reached the mailbox ("Show original" or "View
   source" in most mail clients). Find the topmost `Authentication-Results:` line. The
   word after the colon is the authserv-id, for example `mx.example.com` in
   `Authentication-Results: mx.example.com; dkim=pass …`.
2. Set it as `incoming.authserv_id` in the manifest. Your provider may use more than
   one; list each.
3. Send a test mail from the trusted address and check its event:
   `payload.auth.dmarc` must be `pass`.

The connector reads only the topmost header with a trusted authserv-id. The receiving
server puts its own header above any header the sender wrote. Every result you filter
on must therefore be in that one header.

> [!WARNING]
> This works only when the server adds one header with all its results to every mail
> it accepts. On a server you run yourself, separate DKIM, SPF and DMARC filters often
> write one header each; then only the topmost one counts and `dmarc` is often `none`.
> Make the server write the results in one header, and make it remove any header with
> its own authserv-id that arrives from outside.

> [!NOTE]
> Microsoft 365 and Outlook.com write `Authentication-Results` without an authserv-id
> (`Authentication-Results: spf=pass …`). The connector cannot tell such a header from
> one the sender wrote, so it ignores it, and every result in `auth` is `none`.

### `mark_read`

```yaml
args: { folder: INBOX, uid: "${event.payload.uid}" }      # or message_id: "${event.payload.message_id}"
```

Sets the "seen" flag on one message. Result `{ ok, supported }`. IMAP only: on POP3 the
result is `{ ok: false, supported: false }`. Pass `uid` or `message_id`; a message that is
not found gives `{ ok: false, supported: true }`.

### `send`

```yaml
args:
  to: "${event.payload.from}"
  subject: "Re: ${event.payload.subject}"
  in_reply_to: "${event.payload.message_id}"
  references: ${event.payload.references}
  text: "Thanks, we are on it."
```

Arguments: `to` (one address or a list), `cc`, `bcc`, `subject`, `text` and/or `html`
(one of them is required), `reply_to`, `in_reply_to`, `references`, `attachments`
(`{ filename, content, encoding: utf8 | base64, content_type }`; content only, never a
file path). Result `{ message_id, accepted, rejected }`.

The footer is appended to `text`, `footer_html` to `html`. `in_reply_to` is also added to
the `References` header, so your reply threads under the original in the recipient's
client.

A mail server that cannot be reached, a connection that breaks or times out, a POP3
mailbox locked by another session, and an SMTP `4xx` reply are [transient](../tasks/connector.md#failures): the calling run
is retried under the task's `retry` policy. Every other op failure (a bad folder, no
`incoming` configured, a refused login, SMTP refusing a recipient with a `5xx`) fails the
calling run without retry. A connector that is down fails it with retry.

## Events

The connector emits nothing. Your task does, from the result of `fetch_new`:

```yaml
emit:
  - type: email.received
    each: ${result.emails}
    dedup_key: "email:${item.message_id}"
    payload: ${item}
```

## State

The connector keeps what is not per caller in the daemon's state store, under its own
name (`GET /v1/state/email`):

| Key | Backend | Value |
|---|---|---|
| `uidvalidity` | IMAP | the folder's `UIDVALIDITY`, to detect a reset |
| `seen_uidls` | POP3 | the handled identifiers that are still on the server |
| `pending_uidls` | POP3 | the last batch delivered, handled once its `last_uid` comes back |

The cursor itself is task state (`state_updates: { email.last_uid: ${result.last_uid} }`).
On IMAP, two tasks can read the same mailbox with independent cursors, as the
daily-digest example does.

## Tasks

The poll, with the cursor and the fan-out:

```yaml
tasks:
  - name: fetch_email
    trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }
    action:
      kind: connector
      connector: email
      op: fetch_new
      args: { folder: INBOX, since_uid: "${state.email.last_uid}" }
    state_updates:
      email.last_uid: ${result.last_uid}
    emit:
      - type: email.received
        each: ${result.emails}
        dedup_key: "email:${item.message_id}"
        payload: ${item}

  - name: acknowledge
    trigger:
      kind: event
      type: email.received
      filter: "payload.from != 'noreply@example.com'"
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: email
          op: send
          args:
            to: "${event.payload.from}"
            subject: "Re: ${event.payload.subject}"
            in_reply_to: "${event.payload.message_id}"
            references: ${event.payload.references}
            text: |
              Hello,

              we received your message "${event.payload.subject}" and will get back to you shortly.
        - kind: connector
          connector: email
          op: mark_read
          args: { folder: INBOX, uid: "${event.payload.uid}" }
```

> [!TIP]
> Put the relevance check in the trigger `filter` (the sender, a word in the subject),
> not in a model prompt. A filtered-out event costs nothing.

> [!WARNING]
> The first `fetch_new` with `initial: none` returns nothing and marks the mailbox as
> seen. To process mail that is already there, set `initial: all` before the first run,
> or send a new message after the daemon is up.

Two complete examples ship with the connector:
[`auto-reply.yaml`](../../connectors/email/examples/auto-reply.yaml) acknowledges every
message and marks it read, and [`daily-digest.yaml`](../../connectors/email/examples/daily-digest.yaml)
keeps a second cursor on the same IMAP mailbox for one digest mail per weekday morning.
