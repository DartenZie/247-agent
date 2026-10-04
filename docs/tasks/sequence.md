# `sequence`

A few steps in one run, for work that is too tightly coupled to split into separate
tasks and events: ask, wait, act. Steps share the run and see each other's results.

## The smallest example

```yaml
tasks:
  - name: approve_general_change
    trigger: { kind: event, type: site.change_ready }
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: chat
          op: ask
          args:
            text: "Site change ready: ${event.payload.summary}\n${event.payload.diff}\nApprove?"
            correlation_id: ${event.correlation_id}
        - kind: wait
          for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
          timeout: 24h
          on_timeout: fail
        - kind: shell
          when: "steps[1].payload.approved == `true`"
          cwd: ${event.payload.worktree}
          cmd: ["git", "push", "origin", "HEAD:main"]
```

Steps are [`shell`](shell.md), [`connector`](connector.md) or [`wait`](wait.md)
actions, each with the fields of that action plus an optional `when`. Model actions and
nested sequences are not steps: a model step is a task of its own, so its cost and its
result are visible as such.

## Results and `when`

Inside later steps, `steps[i]` is the result of step *i*, counting from zero, so
`steps[1].payload.approved` reads the reply the wait received. A step whose `when` is
falsy is skipped and its result is `null`. `when` is a JMESPath expression over the
template scope, so `steps`, `event`, `state` and `run` are all available.

The run's result is `{ steps: [...] }` with every step's result in order, and
`emit` rules read it the same way: `${result.steps[2]}`.

## Waiting inside a sequence

A `wait` step suspends the whole run, exactly like a `wait` action. The sequence
remembers which step it reached and the results so far. When the event arrives, or
after a restart of the daemon, it continues from that step with the matched event as
its result; the steps before it are not run again.

A retry works the same way: if an attempt fails after the wait was answered, the next
attempt starts again at the wait step with the same answer, and runs the steps after
it. An attempt that failed before reaching the wait starts over from the first step.

> [!TIP]
> Keep sequences short and local. Anything another workflow might want to observe or
> reuse, such as "the site was published", should be its own task publishing its own
> event. The sequence above does one thing: it gets a yes and pushes.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `steps` | yes, at least one | a list of `shell`, `connector` or `wait` actions |
| `steps[].when` | no | a JMESPath expression; a falsy value skips the step |

The remaining fields of a step are those of its action kind.
