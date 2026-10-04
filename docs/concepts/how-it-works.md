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

Every event and run is committed to the database before anything acts on it. A crash
never loses an email and never runs a finished job again: dispatch is at-least-once,
and the dedup key plus one run per task and event make it effectively once. When the
daemon starts, runs that were mid-flight are retried if their policy allows and failed
as interrupted otherwise; waiting runs keep waiting.

Two things are deliberately not replayed: cron ticks missed while the daemon was down,
and events caught in a runaway chain. Each event records how many hops it is from the
root of its causal chain; past a configurable depth, an event is stored but starts no
run.

## What the daemon never does

- It never calls a model to decide whether something matches, whether a run should
  retry, or where a result should go. That is all configuration and code.
- It never lets an agent publish, deploy or hold a deploy credential. An agent edits a
  workspace; a deterministic gate checks it; a separate task ships it.
- It never writes a secret's value into the database, a log line or an event.

Next: [Models and cost](models-and-cost.md), then [Security](security.md).
