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
    emit:
      - type: site.change_pushed
        when: "result.steps[2] != `null`"
        payload: { summary: "${event.payload.summary}" }
```

Steps are [`shell`](shell.md), [`connector`](connector.md), [`wait`](wait.md),
[`llm`](llm.md), [`decide`](decide.md) or [`agent`](agent.md) actions, each with the
fields of that action plus an optional `when`. A sequence cannot be a step, and a
sequence has at most one `agent` step.

## Model steps

An `llm`, `decide` or `agent` step works like the same action on its own. Its result is
`steps[i]`, so a later step can act on a classification:

```yaml
tasks:
  - name: triage_issue
    trigger: { kind: event, type: issue.opened }
    budget: { max_usd: 0.50 }
    action:
      kind: sequence
      steps:
        - kind: llm
          input: "Title: ${event.payload.title}\n\n${event.payload.body}"
          output_schema:
            type: object
            properties: { kind: { type: string, enum: [bug, feature, question] } }
            required: [kind]
        - kind: connector
          when: "steps[0].kind == 'bug'"
          connector: chat
          op: send
          args: { text: "New bug: ${event.payload.title}" }
```

The budget is the run's. The task's `budget.max_usd` and a step's own `budget.max_usd`
both cap what the whole run spent, earlier model steps included, and `budgets.daily_usd`
applies on top. An `agent` step without a budget of its own uses
`defaults.agent.budget.max_usd`, so that cap also counts what earlier steps spent. Every model call is in the ledger under the run's id. `oa validate`
checks a model step as it checks the action on its own, for example that its model has
a price.

A batched `llm` step (`batch: true`) suspends the run like a `wait` step until the
batch result arrives. An `agent` step that ends `blocked` still finishes, and its
result has `status: blocked`. Test it in a later step's `when`, for example
`steps[1].status == 'done'`. The step's `post` gates can read `steps` as well as
`result`.

> [!WARNING]
> Do not publish from the same sequence as an `agent` step. A step after the agent
> that uses a deploy secret runs in a workspace the agent wrote, without a human check
> in between. Publish from a task of its own that holds the secret, triggered by an
> event after review.

## Results and `when`

Inside later steps, `steps[i]` is the result of step *i*, counting from zero, so
`steps[1].payload.approved` reads the reply the wait received. A step whose `when` is
falsy is skipped and its result is `null`, and the run still succeeds. A rejected
approval therefore ends `succeeded` like an approved one; route on it with an `emit`
rule that tests the step's result, as `site.change_pushed` does above. `when` is a JMESPath expression over the
template scope, so `steps`, `event`, `state` and `run` are all available.

The run's result is `{ steps: [...] }` with every step's result in order. `emit`
rules and `state_updates` read it as `result.steps`, for example `${result.steps[2]}`.
After the sequence, `steps` alone is `null`. `length(steps[0].emails)` fails the run,
and `${steps[0].last_uid}` renders `null` without an error.

## Waiting inside a sequence

A `wait` step suspends the whole run, exactly like a `wait` action. The sequence
remembers which step it reached and the results so far. When the event arrives, or
after a restart of the daemon, it continues from that step with the matched event as
its result; the steps before it are not run again.

A retry works the same way. The sequence records each step that finishes, and the
next attempt starts at the step that failed, with the earlier results. A step that
finished is not run again, so a mail that a `send` step sent is not sent twice. A
retry after a restart of the daemon also starts at the step that failed. If the daemon
stops after a step finishes but before the sequence records it, that step runs again.

If you edit the task and run `oa reload` while a run waits or retries, that run keeps
the steps it started with. Only runs that start after the reload use the new steps. If
you remove the task, its runs in flight fail.

> [!TIP]
> Keep sequences short and local. Anything another workflow might want to observe or
> reuse, such as "the site was published", should be its own task publishing its own
> event. The sequence above does one thing: it gets a yes and pushes.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `steps` | yes, at least one | a list of `shell`, `connector`, `wait`, `llm`, `decide` or `agent` actions, with at most one `agent` |
| `steps[].when` | no | a JMESPath expression; a falsy value skips the step |

The remaining fields of a step are those of its action kind.
