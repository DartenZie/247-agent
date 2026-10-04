# Routing

A task's result becomes events, and events start other tasks. This page covers the
events every task publishes on its own, the `emit` rules that add yours, and
`state_updates`, which lets a run remember something for the next one.

## What every task publishes

After each run the daemon publishes one lifecycle event, with no configuration:

| Event | When | Payload |
|---|---|---|
| `task.<name>.succeeded` | the run succeeded | the action's result |
| `task.<name>.failed` | the run failed, once, after the last retry attempt | `{ run_id, task, error, attempt }` |

These carry the source `task:<name>`, the event that triggered the run as their parent,
and that event's correlation id. Chain on them when the next step needs nothing but
"it worked":

```yaml
- name: publish_site
  trigger:
    kind: event
    type_any: [task.update_event_list.succeeded, task.approve_general_change.succeeded]
  concurrency: 1
  action: { kind: shell, cwd: /var/lib/247-agent/repos/website, cmd: ["bash", "-c", "npm run build && ./deploy.sh"] }
```

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
  rule, `item` is the current element.
- **`dedup_key`** makes delivery idempotent: a later event with the same key is dropped.
  Give one to anything that can be fetched twice, built from a stable id in the data.
- **`payload`** is the event's data, templated. A value that is exactly one `${…}`
  keeps its type, so `payload: ${item}` publishes the object as it is.

Emitted events carry `source: task:<name>`, the trigger event as their parent, and
inherit its correlation id. That is what lets `oa` and the logs show one real-world
happening from the email to the chat message that reported it.

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
keep their own cursors in the same store under their own name, and `oa` can read and
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

Each event records how many hops it is from the root of its causal chain. Past
`limits.max_event_depth` in `agent.yaml`, 32 by default, an event is still stored and
still ends a `wait` that matches it, but starts no run. If you see events dropped for
depth, two tasks are feeding each other: break the loop with a filter or a `dedup_key`.

## Where to look

- `oa events tail --type 'email.*' --follow` watches events as they are published.
- `oa events show <id>` prints one with its payload.
- `oa runs show <id>` prints a run with the event that started it and its result.
