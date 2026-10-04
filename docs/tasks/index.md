# Tasks

A task is the unit of automation: one trigger, one action, and the routing of the
result into new events. This page shows the shape of a task, where tasks files live,
and how runs, retries and timeouts behave. The other pages in this section cover each
part in depth.

## Anatomy

```yaml
tasks:
  - name: fetch_email                              # [a-z][a-z0-9_]*, unique across all tasks files
    trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }   # when it runs
    action:                                        # what it does
      kind: connector
      connector: email
      op: fetch_new
      args: { since_uid: "${state.email.last_uid}" }
    concurrency: 1                                 # runs of this task at the same time
    timeout: 5m                                    # per attempt of active work
    retry: { attempts: 3, backoff: exponential, base: 30s, max: 10m }
    state_updates:                                 # remembered after a successful run
      email.last_uid: ${result.last_uid}
    emit:                                          # what the result becomes
      - type: email.received
        each: ${result.emails}                     # one event per mail
        dedup_key: "email:${item.message_id}"
        payload: ${item}
```

- The **trigger** says when: a cron schedule, an event type with an optional filter, or
  only by hand. See [Triggers](triggers.md).
- The **action** is the one thing the task does. Seven kinds exist: [`shell`](shell.md),
  [`connector`](connector.md), [`wait`](wait.md), [`sequence`](sequence.md),
  [`llm`](llm.md), [`decide`](decide.md) and [`agent`](agent.md).
- **Routing** turns the result into events with `emit`, and `state_updates` keeps
  values for later runs. See [Routing](routing.md).
- Values written as `${…}` are templates, filled in at run time from the event, the
  result, state or a secret. See [Templates](templates.md).

The complete list of fields on a task is in the [task reference](../reference/task.md).

## Where tasks live

A tasks file is a YAML file with one key, `tasks`, holding a list. `agent.yaml` names
the files under `tasks:`: one file, a directory (every `*.yaml` in it, in name order),
or a list of both. The daemon merges them, so you can keep one file per workflow:

```yaml
# agent.yaml
tasks: [tasks.yaml, tasks.d]
```

Task names must be unique across all of them. In production the directory is
`/etc/247-agent/tasks.d/`; a change takes effect on `oa reload`, which applies every
file together or none of them if any is invalid.

## What a task publishes on its own

Every task publishes a lifecycle event after each run, without any `emit` rule:

| Event | When | Payload |
|---|---|---|
| `task.<name>.succeeded` | the run succeeded | the action's result |
| `task.<name>.failed` | the run failed, once, after the last attempt | `{ run_id, task, error, attempt }` |

Other tasks listen on these to chain work ("publish after the build succeeded") or to
report failures (`task.*.failed`). A task can never trigger on events from its own
runs, so a task that reports failures cannot loop on its own failure.

## Runs, attempts and timeouts

Each matching event starts one **run**. A run is `queued`, then `running`, sometimes
`waiting`, and ends `succeeded`, `failed` or `cancelled`. `oa runs show <id>` prints
everything about it: the event that started it, the result or the error, each attempt,
the model calls and their cost.

- **`concurrency`** is how many runs of this task may execute at once. The default is
  1. `workers` in `agent.yaml` caps all tasks together; its default is 4.
- **`timeout`** bounds each attempt of active work. The default comes from
  `defaults.timeout` in `agent.yaml`, 15 minutes. Time a run spends `waiting`, for a
  human's reply or a batch result, does not count. When the timeout expires the attempt
  is aborted, and for an agent its session is cancelled.
- **`retry`** gives a run several attempts. Attempts belong to the same run: it stays
  `running` between them, with the last error recorded, and `task.<name>.failed` is
  published once, after the last attempt. With `backoff: fixed` every pause is `base`;
  with `exponential` the pause before attempt *n* is `base × 2^(n−1)`, capped at `max`.
  The default is a single attempt.

```yaml
retry: { attempts: 3, backoff: exponential, base: 30s, max: 1h }
```

What a retry helps with and what it does not:

| Retried | Not retried |
|---|---|
| a timeout of the attempt | a `wait` that timed out |
| a connector that is down | a secret that is not set, an unknown connector |
| a provider's rate limit or server error | a provider rejecting the request (bad key, bad schema) |
| an agent's failed `post` gate, or a missing or invalid `RESULT.json` | a model call over budget, a truncated or refused answer |
| | an agent that broke its policy or hit its tool-call cap |
| | an `emit` rule that cannot be rendered, an op the connector reported as an error |

An `agent` retry starts in a fresh workspace with the previous error in its prompt, so
a build the agent broke gets a second chance. Set `retry.attempts` with the cost of a
second session in mind.

When the daemon restarts, a run that was `running` is retried if its policy allows
another attempt and failed as interrupted otherwise. Waiting runs keep waiting.

## Budgets

`budget: { max_usd: 0.5 }` on a task caps what one run may spend on models. An action
may carry its own `budget`; the smaller of the two applies. The global daily cap is in
`agent.yaml`. [Models and cost](../concepts/models-and-cost.md) explains how both are
enforced.

## In this section

| Page | What it covers |
|---|---|
| [Triggers](triggers.md) | cron, event with filters, manual, and `oa run` |
| [`shell`](shell.md) | run a command, with or without a sandbox |
| [`connector`](connector.md) | call one operation on a connector |
| [`wait`](wait.md) | pause until an event arrives |
| [`sequence`](sequence.md) | a few steps in one run |
| [`llm`](llm.md) | one model call with a JSON answer |
| [`decide`](decide.md) | typed questions, probabilities back |
| [`agent`](agent.md) | an agent session in a workspace, with gates |
| [Routing](routing.md) | `emit`, `state_updates`, lifecycle events |
| [Templates](templates.md) | `${…}`, JMESPath, filters |

Complete workflows to copy are in [Recipes](../recipes/website-from-email.md).
