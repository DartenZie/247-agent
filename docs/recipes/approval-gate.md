# Ask a human before acting

A change is ready, but nothing should ship until you tap Approve on your phone. The run
waits for your answer, for a day if need be, and survives a daemon restart in between.

## What you need

- The [chat connector](../connectors/chat.md), on Telegram or Matrix. Both offer the same
  `ask` operation and the same `chat.reply` event, so the task below works on either.
- An event that says something is ready to be approved. Here it is `site.change_ready`
  with a `summary`, a `diff` and the `worktree` the change sits in, as the reference
  workflow publishes it.

## The task

```yaml
tasks:
  - name: approve_change
    trigger: { kind: event, type: site.change_ready }
    action:
      kind: sequence
      steps:
        # 1. Ask. The correlation id ties the question to this run.
        - kind: connector
          connector: chat
          op: ask
          args:
            text: "Site change ready: ${event.payload.summary}\n${event.payload.diff}\nApprove?"
            correlation_id: ${event.correlation_id}
        # 2. Wait for the reply to this question, up to a day.
        - kind: wait
          for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
          timeout: 24h
          on_timeout: fail
        # 3. Act only when the first option was chosen.
        - kind: shell
          when: "steps[1].payload.approved == `true`"
          cwd: ${event.payload.worktree}
          cmd: ["git", "push", "origin", "HEAD:main"]
```

## How it works

1. `ask` posts the question with two buttons, Approve and Reject by default, and stores
   the question together with the correlation id you passed. On Matrix the options are
   keycap reactions under the message instead of buttons.
2. The `wait` step parks the run. The daemon frees the worker, records the wait in its
   database, and the run shows as `waiting` in `oa runs ls`. A restart does not lose it.
3. You tap a button, or reply to the question with the text of an option. The connector
   publishes a `chat.reply` event whose payload carries the answer:

   ```json
   {
     "correlation_id": "cor_01J…",
     "approved": true,
     "choice": "Approve",
     "text": "Approve",
     "from": { "id": 987, "name": "Miro P", "username": "miro" },
     "message_id": 815,
     "chat_id": "123456789",
     "answer_message_id": null
   }
   ```

   The event itself also carries that correlation id, so `oa events tail` shows the
   whole story under one id.
4. The wait's filter is rendered first, turning `${event.correlation_id}` into this run's
   id, then evaluated against every incoming event. Only the reply to this question
   matches, however many questions are open.
5. The sequence resumes at step 3. `steps[1]` is the matched event, so
   `steps[1].payload.approved` is `true` for the first option. With `when` false the push
   is skipped and the run still succeeds, with `null` for that step in the result.

## Make it yours

- **Other options.** Pass `options: [Deploy now, Tomorrow, Cancel]` to `ask`. `approved`
  is true for the first option; read `steps[1].payload.choice` for the rest and branch
  with several `when` steps.
- **Reject means something.** Add a step with `when: "steps[1].payload.approved ==
  \`false\`"` that cleans up or tells the requester.
- **Timeout as a decision.** `on_timeout: succeed` makes a silent day count as an answer:
  the step result is `{ "timed_out": true }` and later steps can test it. With `fail`,
  the run fails without a retry and `task.approve_change.failed` reaches your
  [notify task](notify-on-failure.md).
- **Separate tasks instead of a sequence.** If another workflow should see the question
  or the answer, make the ask its own task, publish an event, and let a second task wait.
  A sequence is for steps nobody else needs to observe.

> [!WARNING]
> Match the reply on the correlation id, never on "the next reply". Two questions can be
> open at once, and the first answer that arrives is not necessarily yours.

> [!TIP]
> The task's `timeout` bounds each stretch of active work, not the wait. A task with
> `timeout: 5m` can wait 24 hours and still have five minutes for the push.

> [!NOTE]
> A wait timeout is not retried, whatever the task's `retry` says. The run fails once,
> and the event that triggered it can be replayed with `oa run approve_change --event`.

Related: [`wait`](../tasks/wait.md), [`sequence`](../tasks/sequence.md),
[chat connector](../connectors/chat.md).
