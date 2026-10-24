# Routing

A task's result becomes events, and events start other tasks. This page covers the
events every task publishes on its own, the `emit` rules that add yours, and
`state_updates`, which lets a run remember something for the next one.

## What every task publishes

After each run the daemon publishes one lifecycle event, with no configuration:

| Event | When | Payload |
|---|---|---|
| `task.<name>.succeeded` | the run succeeded | `{ run_id, task, result }`, with the action's result in `result` |
| `task.<name>.failed` | the run failed, once, after the last retry attempt | `{ run_id, task, error, attempt }` |

These carry the source `task:<name>`, the event that triggered the run as their parent,
and that event's correlation id. Chain on them when the next step needs nothing but
"it worked":

```yaml
- name: compress_dump
  trigger: { kind: event, type: task.dump_database.succeeded }
  action: { kind: shell, cmd: ["gzip", "-f", "/var/backups/site.sql"] }
```

> [!WARNING]
> `succeeded` means the run ended without an error, not that it changed anything. An
> `agent` run whose result is `blocked` succeeds, and so does a `sequence` whose push
> step was skipped because a human rejected it. When the next task must run for one
> outcome only, such as publishing after a change was pushed, emit your own event with a
> `when` and trigger on that. See [`emit`](#emit-your-own-events).

And listen on `task.*.failed` once, in a task that tells you:

```yaml
- name: notify
  trigger: { kind: event, type_any: ["task.*.failed", budget.exceeded] }
  action:
    kind: connector
    connector: chat
    op: send
    args: { text: "[247-agent] ${event.type}: ${event.payload.error || event.payload.spent_usd}" }
```

A task never matches events from its own runs, so `notify` cannot loop on its own
failure.

## `emit`: your own events

`emit` is a list of rules. Each publishes one event, or one per item, from the result:

```yaml
emit:
  - type: email.received
    each: ${result.emails}                  # one event per element, available as `item`
    dedup_key: "email:${item.message_id}"
    payload: ${item}
  - type: email.classified
    when: "result.kind != 'ignore'"         # JMESPath over {event, result, state, env, run}
    payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

- **`type`** is a concrete event type, dotted lowercase segments, no `*`. Name it after
  what happened: `email.received`, `site.change_ready`, `report.disk`.
- **`when`** is a JMESPath expression; a falsy value skips the rule. This is where a
  threshold or an outcome check lives: `` result.confidence > `0.7` ``,
  `result.status == 'blocked'`.
- **`each`** fans a list out into one event per element. It must be a single `${…}`
  that renders to a list; `null` emits nothing, anything else fails the run. Inside the
  rule, `item` is the current element. Each element is its own happening, so each event
  gets a new correlation id.
- **`dedup_key`** makes delivery idempotent: a later event with the same key is dropped.
  Give one to anything that can be fetched twice, built from a stable id in the data.
- **`payload`** is the event's data, templated. A value that is exactly one `${…}`
  keeps its type, so `payload: ${item}` publishes the object as it is.

Emitted events carry `source: task:<name>` and the trigger event as their parent. An
event from a rule without `each` inherits the trigger's correlation id; an event from an
`each` rule gets a new one. That is what lets `oa` and the logs show one real-world
happening from the email to the chat message that reported it, and what lets an
[approval gate](../recipes/approval-gate.md) wait for the answer to its own item only.

> [!NOTE]
> All rules are rendered before anything is written. A rule that cannot be rendered,
> such as an `each` that is not a list, fails the run without retry, and nothing is
> emitted. A rule with a falsy `when` is skipped, not an error.

## `state_updates`: remembering between runs

```yaml
state_updates:
  email.last_uid: ${result.last_uid}
```

Keys are `<namespace>.<key>`, each part lowercase letters, digits, `_` or `-`. Values
are templated. They are written only after a successful run, and read back in any
template as `${state.email.last_uid}`, a snapshot taken when the run starts. Connectors
keep their own memory in the same store under their own name, and `oa` can read and
change any value through the API: see [the API reference](../reference/api.md).

## One transaction

The run's status, its `state_updates`, its lifecycle event and every emitted event are
written together. Either all of them exist or none, so a crash between "the run
succeeded" and "the events are out" cannot happen.

## Secrets never travel

`secrets` is not allowed in `emit` or `state_updates`; `oa validate` refuses it with
"secrets cannot be used here: they would be written to the store or an event". A
secret belongs in the action that needs it.

## Runaway chains

Two tasks that each trigger on what the other emits form a loop. `oa validate` warns
about such a cycle at the trigger of its first task:

```
tasks.yaml: tasks[0].trigger: warning: task "ping": event cycle: ping emits "x.pong" to pong, pong emits "x.ping" to ping; …
```

The check ignores filters, so a cycle that a trigger filter ends is reported too. If the
filter really ends it, you can leave the warning.

At run time, two limits in `agent.yaml` stop a loop. Both count the causal chain: the
root event and every event that descends from it, including each item of an `each`
rule.

- `limits.max_event_depth`, 32 by default: an event more hops than this from the root
  starts no run.
- `limits.max_runs_per_chain`, 1000 by default: once a chain has started this many
  runs, its events start no more. This stops a loop that fans out with `each`, which
  would double at every hop long before it got deep.

An event dropped by either limit is still stored and still ends a `wait` that matches
it. The first drop in a chain publishes `loop.detected`, so a task can tell you:

```yaml
tasks:
  - name: alert_loop
    trigger: { kind: event, type: loop.detected }
    action:
      kind: shell
      cmd: ["logger", "-t", "247-agent", "loop stopped: ${event.payload.event_type} (${event.payload.reason})"]
```

To fix the loop, break it with a trigger filter, a `dedup_key`, or a different event
type. The payload of `loop.detected` is in
[the events reference](../reference/events.md#how-an-event-starts-a-run).

## Where to look

- `oa events tail --type 'email.*' --follow` watches events as they are published.
- `oa events show <id>` prints one with its payload.
- `oa runs show <id>` prints a run with the event that started it and its result.
