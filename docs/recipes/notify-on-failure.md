# Hear about every failure

Something failed at three in the morning, or the daily model budget ran out. One task
tells you on chat, and it can never cause a storm of messages about itself.

## What you need

- The [chat connector](../connectors/chat.md) with the `send` op allowed.
- Nothing else: the events this task listens for are published by the daemon itself.

## The task

```yaml
tasks:
  - name: notify
    trigger:
      kind: event
      type_any: ["task.*.failed", budget.exceeded, task.publish_site.succeeded]
    action:
      kind: connector
      connector: chat
      op: send
      args:
        text: "[247-agent] ${event.type} (${event.payload.task}): ${event.payload.error || event.payload.spent_usd || 'ok'}"
```

## How it works

1. Every task publishes `task.<name>.succeeded` or `task.<name>.failed` when a run ends.
   The pattern `task.*.failed` matches the failure of every task, because `*` stands for
   exactly one dotted segment. `task.publish_site.succeeded` adds the one success you
   want to hear about.
2. `budget.exceeded` is published once per day, the moment the daily model budget is
   crossed. After it, every model call fails fast until midnight UTC, so you want to know.
3. The three payloads differ, and the template picks what each has:

   | Event | Payload |
   |---|---|
   | `task.<name>.failed` | `{ "run_id", "task", "error", "attempt" }`, published once, after the last retry attempt |
   | `task.<name>.succeeded` | `{ "run_id", "task", "result" }` |
   | `budget.exceeded` | `{ "scope": "daily", "day", "limit_usd", "spent_usd", "task", "run_id" }` |

   JMESPath's `||` takes the first value that is not null or empty, so a failure shows
   its error, the budget event shows what was spent, and a success shows `ok`.
4. `send` posts the line to the configured chat and returns the message id, which you
   can see in `oa runs show` for the notify run.

## Why it cannot loop

If `send` itself fails, the daemon publishes `task.notify.failed`. That event matches the
pattern `task.*.failed`, but the daemon never lets a task trigger on an event that one of
its own runs produced: every event a task's run publishes carries the source
`task:<name>`, and the matcher skips those for that task. The notify task therefore
cannot react to its own failure, and `oa validate` refuses a trigger that names the
task's own lifecycle event outright.

Two more guards back this up. A `dedup_key` on `budget.exceeded` makes it one event per
day however many calls hit the cap. And every event records its depth in the chain that
caused it; past `limits.max_event_depth` an event starts no run at all.

## Make it yours

- **Only the tasks that matter.** Replace `task.*.failed` with a list:
  `type_any: [task.publish_site.failed, task.update_event_list.failed]`.
- **A richer message.** `${event.payload.run_id}` lets you paste the id straight into
  `oa runs show`. For an agent task's failure, `oa runs logs <id>` has the transcript.
- **Email instead of chat.** Use the email connector's `send` op with the same template.
- **Two channels.** Two tasks on the same trigger run independently; one connector being
  down does not stop the other.

> [!TIP]
> Point `oa events tail --type 'task.*.failed' --follow` at a terminal while you develop
> a workflow. It shows failures live, before you have a chat connector.

> [!NOTE]
> A failure that is retried is not yet a failure. `task.<name>.failed` fires once, after
> the last attempt, so a flaky connector that recovers on the second try sends nothing.

Related: [Routing](../tasks/routing.md) for the lifecycle events,
[Models and cost](../concepts/models-and-cost.md) for the daily budget.
