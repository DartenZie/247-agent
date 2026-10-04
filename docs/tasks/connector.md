# `connector`

Call one operation on a connector: fetch new mail, send a message, write a file, label
a pull request. The daemon is the client; the connector does the work. No model is
involved.

## The smallest example

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
```

`connector` names a manifest, `op` one of the operations it exposes, and `args` the
operation's input. Every value in `args` is templated, and a value that is exactly one
`${…}` keeps its type: `limit: ${event.payload.limit}` passes a number.

Each connector's page lists its operations with their inputs and results:
[email](../connectors/email.md), [ftp](../connectors/ftp.md),
[chat](../connectors/chat.md), [github](../connectors/github.md),
[jira](../connectors/jira.md).

## What the result is

The operation's structured result, as the connector returns it. `${result.emails}` or
`${result.message_id}` in `emit` and `state_updates` read into it. A connector that
returns plain text instead is parsed as JSON when the text is JSON, and kept as a
string otherwise.

## Failures

| What happened | Outcome |
|---|---|
| the connector is down (crashed, restarting, not yet up) | the attempt fails and is retried under the task's `retry` policy |
| the operation reported an error (a bad path, a rejected request, an API error) | the run fails with the connector's error text, without retry |
| `op` is not in the manifest's `ops` list | the run fails without retry |
| `connector` names no manifest | the run fails without retry |
| the call takes longer than `timeout` | the attempt fails and is retried |

Operation errors are deliberately not retried: a path that does not exist or a request
the API rejected will not succeed on a second try, and some operations, such as
sending a message, must not run twice.

> [!TIP]
> The manifest's `ops` list is a boundary, not just documentation. Give an agent a copy
> of a manifest with the read-only operations, and keep `send`, `write` and `delete` on
> the manifest your deterministic tasks use. See [Connectors](../connectors/index.md).

## Timeout

`timeout` bounds one call; the default is 60 seconds. The task's own `timeout` still
bounds the whole attempt.

```yaml
action:
  kind: connector
  connector: ftp
  op: sync
  args: { local: /var/lib/247-agent/repos/site/dist, remote: ".", prune: true }
  timeout: 5m
```

## Turning an operation into events

An operation that lists what exists now (open pull requests, issues with a label, files
in a folder) becomes an event source without a task at all: the built-in
[poller](../connectors/poller.md) calls it on a schedule and publishes one event per
new item. An operation that takes a cursor and returns only what is new, like
`fetch_new` above, is better driven by a cron task with `state_updates` and
`emit … each`, as in the example.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `connector` | yes | | the manifest's `name` |
| `op` | yes | | the operation to call |
| `args` | no | `{}` | the operation's input; values templated |
| `timeout` | no | `60s` | the limit for this one call |
