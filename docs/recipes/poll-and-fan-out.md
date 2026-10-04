# Poll a source and fan out one event per item

A mailbox, a folder or an API has new things from time to time. You want one event per
new item, exactly once, without a model and without writing a poller.

## What you need

- A connector with an operation that returns new items since a cursor, such as the
  [email connector](../connectors/email.md)'s `fetch_new`, or one that lists what exists
  now, such as the [ftp connector](../connectors/ftp.md)'s `list`.
- Somewhere to react: a second task that listens for the event you fan out.

## The tasks

```yaml
tasks:
  # 1. Every two minutes, ask the mailbox for mail newer than the cursor we stored last time.
  - name: fetch_email
    trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }
    action:
      kind: connector
      connector: email
      op: fetch_new
      args: { folder: INBOX, since_uid: "${state.email.last_uid}" }
    state_updates:
      email.last_uid: ${result.last_uid}      # remembered for the next run
    emit:
      - type: email.received
        each: ${result.emails}                 # one event per message
        dedup_key: "email:${item.message_id}"  # a message can never become two events
        payload: ${item}

  # 2. Anything that listens for email.received runs once per message. Here: log it.
  - name: log_email
    trigger:
      kind: event
      type: email.received
      filter: "payload.from == 'editor@example.com'"
    action:
      kind: shell
      cmd: ["logger", "-t", "247-agent", "mail from ${event.payload.from}: ${event.payload.subject}"]
```

The manifest it relies on, in `connectors.d/email.yaml`:

```yaml
name: email
exec: ["247-agent-connector-email"]
transport: stdio
emits: [email.received]
ops: [fetch_new, mark_read]
config:
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming: { protocol: imap, host: imap.example.com, folder: INBOX }
```

## How it works

1. The cron trigger fires every two minutes. With `overlap: skip`, a tick is dropped
   while an earlier run is still queued, running or waiting, so two polls never race.
2. The action calls `fetch_new` with the cursor from state. On the very first run the
   state key does not exist, so `since_uid` renders to `null` and the connector treats
   the mailbox as new: with its default `initial: none` it marks what is already there as
   seen and returns nothing.
3. The connector returns `{ emails: [...], last_uid: 42 }`. After a successful run, the
   daemon writes `last_uid` into state and publishes the events in one transaction, so
   the cursor can never get ahead of the events or fall behind them.
4. `each` renders to the array of messages, and one `email.received` event is published
   per element, with that element available as `item` for the dedup key and the payload.
5. The second task has an event trigger with a filter. Only mail from the editor starts
   a run; everything else is stored as an event and ignored, at no cost.

Try it by hand: `oa run fetch_email --wait` runs the poll now, and
`oa events tail --type email.received` shows what came out.

## Make it yours

- **Another source.** Any op that takes a cursor and returns what is new fits: swap the
  connector, the op and the key you store. Keep the state key under the connector's
  name (`email.last_uid`, `ftp.last_seen`) so `GET /v1/state/<namespace>` shows it.
- **A listing op instead of a cursor.** When the op returns what exists now, such as
  files in a folder, the cursor is the item itself. Fan out with a filter inside `each`
  and a dedup key built from what identifies a version of the item:

  ```yaml
  emit:
    - type: ftp.file_seen
      each: "${result.entries[?type == 'file']}"
      dedup_key: "ftp:${item.path}:${item.size}:${item.mtime}"
      payload: ${item}
  ```

  The filter goes in `each` because `when` runs once per rule, not once per item.
- **No code at all.** For an op that lists what exists now (open pull requests, issues
  with a label), the built-in [poller](../connectors/poller.md) does all of this from a
  manifest, remembers what it has seen, and emits one event per new item.
- **Reset the cursor.** Delete the state key and the next poll starts over; the dedup
  key still drops items whose event the database already holds.

> [!WARNING]
> Quote templates inside a flow mapping: `{ since_uid: "${state.email.last_uid}" }`. An
> unquoted `${` would start a nested map and the file would not parse.

> [!TIP]
> Put every cheap relevance check in the listening task's `filter` (the sender, a label,
> a file name pattern). A filtered-out event costs nothing; a run that then decides to do
> nothing still costs a worker slot and a row in the run history.

Related: [Routing](../tasks/routing.md) for `each`, `dedup_key` and `state_updates`;
[Triggers](../tasks/triggers.md) for cron and `overlap`.
