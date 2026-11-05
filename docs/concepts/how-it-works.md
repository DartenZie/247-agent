# How it works

This page gives you the mental model behind every configuration file: events, triggers,
tasks, runs and connectors, and the few rules that hold them together. Read it once;
the rest of the documentation assumes it.

## Everything is an event

An event is a small record: a **type** such as `email.received`, a **source** (which
connector or task published it), a timestamp, and a **payload** with the data. The
daemon stores every event in its SQLite database before anything acts on it.

```json
{
  "id": "evt_01J…",
  "type": "email.received",
  "source": "email",
  "ts": "2026-09-19T10:00:00Z",
  "correlation_id": "cor_01J…",
  "dedup_key": "email:<message-id@example.com>",
  "payload": { "from": "editor@example.com", "subject": "Spring event", "body": "…" }
}
```

Two fields do a lot of work:

- The **correlation id** threads one real-world happening through everything it
  causes. The email above, the classification of it, the agent run it starts and the
  chat question asking you to approve the result all share one id. That is how a reply
  on chat finds the run that is waiting for it, and how `oa` shows you the whole story.
- The **dedup key** makes delivery idempotent. If the mailbox is fetched twice, the
  second `email.received` with the same key is dropped. You choose the key, usually
  from a stable id in the data.

## A task is a trigger, an action and routing

```yaml
tasks:
  - name: fetch_email
    trigger: { kind: cron, schedule: "*/2 * * * *" }     # when
    action: { kind: connector, connector: email, op: fetch_new }   # what
    emit:                                                 # what the result becomes
      - type: email.received
        each: ${result.emails}
        dedup_key: "email:${item.message_id}"
        payload: ${item}
```

- The **trigger** says when the task runs: on a cron schedule, when an event of a given
  type arrives, or only when you start it by hand with `oa run`. An event trigger can
  carry a **filter**, a cheap expression over the event, so that only relevant events
  start a run. "Only mail from the editor" is a filter, not a model call.
- The **action** is the one thing the task does. There are seven kinds, from running a
  command to opening an agent session. See [Tasks](../tasks/index.md).
- **Routing** turns the result into new events. Every task automatically publishes
  `task.<name>.succeeded` or `task.<name>.failed`; `emit` rules add your own event
  types, including one event per item of a list.

Tasks never call each other by name. A task that should run "after `fetch_email`"
listens for an event `fetch_email` publishes. You can add a second listener, or remove
the first, without touching anything else. The daemon also refuses to let a task
trigger on events from its own runs, so a task that reports failures cannot loop on
its own failure.

## A run is one execution for one event

Each matching event starts exactly one **run** of the task. A run goes through
`queued`, `running`, sometimes `waiting`, and ends `succeeded`, `failed` or
`cancelled`. The run keeps its input event, its result or error, every model call it
made with the cost, and for an agent the whole transcript. `oa runs show <id>` prints it.

Retries belong to the run. With `retry: { attempts: 3 }` a run makes up to three
attempts with a backoff between them, and `task.<name>.failed` is published once,
after the last one. A run that is `waiting`, for a human's reply or for a batch result,
holds no worker and no timer; it survives a restart of the daemon and resumes when its
event arrives.

## Connectors talk to the outside world

A **connector** is a separate program the daemon starts and supervises. It can do two
things, or both:

- **emit events** into the daemon: a chat bot emits `chat.message` as messages arrive,
  a webhook receiver emits one event per verified request;
- **expose operations** that tasks call: `email.fetch_new`, `email.send`, `ftp.write`,
  `github.create_issue`. Operations are MCP tools, so any existing MCP server works as
  a connector too.

A poll-style source such as a mailbox usually emits nothing itself: a cron task calls
its `fetch_new` op and fans the result out as events. For an operation that simply
lists what exists now (open pull requests, issues with a label), the built-in
**poller** turns new items into events without any code.

Connectors keep nothing on disk. Cursors and other memory go in the daemon's **state**
store, so a connector can be restarted at any time. Tasks read state in templates
(`${state.email.last_uid}`) and write it after a successful run.

## What survives, and what does not

Every event and run is committed to the database before anything acts on it. If the
daemon crashes or restarts, it loses no event and never runs a finished job again:
dispatch is at-least-once, and the dedup key plus one run per task and event make it
effectively once. When the daemon starts, runs that were mid-flight are retried if
their policy allows and failed as interrupted otherwise; waiting runs keep waiting.

An operating-system crash or a power loss is different. The database reports a commit
as done before the operating system has written it to disk, so the most recent events,
runs and state changes can be lost. A run that had finished can run again when the
daemon starts. The effect on events depends on how the event got in:

- When the daemon reads from a source and keeps its place in state, such as the
  `last_uid` of an email task, the place is lost together with the event. The next
  poll reads the same messages again, as long as the source still has them, and the
  tasks they start run again.
- When the source was told that the event arrived, or the event was removed from the
  source, the event is lost. Examples are a webhook that already answered 202, a
  Telegram update that the next poll confirmed, and mail that the POP3 connector
  deleted with `delete_after_fetch`.

To lower the risk, run the server on a UPS or on storage that protects its write cache
against power loss. For events you cannot lose, prefer a source that the daemon reads
from over one that pushes to it.

Two things are deliberately not replayed: cron ticks missed while the daemon was down,
and events caught in a runaway chain. At startup, a cron task that missed ticks
publishes one `cron.missed` event, and a task with `missed: run_once` runs once to make
up for them. Each event records how many hops it is from the root of its causal chain;
past a configurable depth, an event is stored but starts no run.

## What the daemon never does

- It never calls a model to decide whether something matches, whether a run should
  retry, or where a result should go. That is all configuration and code.
- It never lets an agent publish, deploy or hold a deploy credential. An agent edits a
  workspace; a deterministic gate checks it; a separate task ships it.
- It never writes a secret's value into the database, a log line or an event.

Next: [Models and cost](models-and-cost.md), then [Security](security.md).
