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
| the operation reported a transient error (the service could not be reached, it timed out, it is rate limiting or answered with a server error) | the attempt fails with the connector's error text and is retried under the task's `retry` policy |
| the operation reported any other error (a bad path, a rejected request, an API error) | the run fails with the connector's error text, without retry |
| `op` is not in the manifest's `ops` list | the run fails without retry |
| `connector` names no manifest | the run fails without retry |
| no answer came: the call took longer than `timeout`, the task's `timeout` cut it off, or the connector exited mid-call | the run fails without retry |

The connector decides which of its errors are transient. A transient error means the
operation did not get through and can succeed later: a connection that failed, broke or
timed out, a rate limit (HTTP 429), or a server error (HTTP 5xx). The bundled connectors
mark these, so a short outage or a rate limit of the mail server, GitHub, Jira, Telegram,
Matrix or the FTP server costs an attempt, not the message. Set `retry` on the task to
use it; with the default of one attempt, a transient error fails the run as any other.

Every other operation error is deliberately not retried: a path that does not exist or a
request the API rejected will not succeed on a second try.

> [!NOTE]
> A connection that broke or timed out after the request was sent can, rarely, hide a
> request that did get through. A retry then repeats it, for example a second chat
> message or a second mail. Mail servers behave the same way.

A call that got no answer is not retried for the same reason. The connector may have
finished the operation, or may still be running it, so a second call could send the
mail twice or run two syncs on the same folder. The error ends with `it may have taken
effect`. Check the remote side, then replay the event if the operation did not happen.

> [!TIP]
> The manifest's `ops` list is a boundary, not just documentation. Give an agent a copy
> of a manifest with the read-only operations, and keep `send`, `write` and `delete` on
> the manifest your deterministic tasks use. See [Connectors](../connectors/index.md).

## Timeout

`timeout` bounds one call; the default is 60 seconds. The task's own `timeout` still
bounds the whole attempt. Set it longer than the slowest call you expect: a call that
runs past it fails the run without retry (see [Failures](#failures)).

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
