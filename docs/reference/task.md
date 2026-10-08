# Task

The envelope every task shares, the grammars the fields use, and what `oa validate`
checks on a tasks file. The fields of each action are on the action's page under
[Tasks](../tasks/index.md).

## The envelope

A tasks file is a `tasks` list. Unknown keys are rejected.

```yaml
tasks:
  - name: fetch_email                 # [a-z][a-z0-9_]*, unique across every tasks file
    trigger: { kind: cron, schedule: "*/2 * * * *" }
    action: { kind: connector, connector: email, op: fetch_new }
    concurrency: 1
    timeout: 15m
    retry: { attempts: 3, backoff: exponential, base: 30s, max: 1h }
    budget: { max_usd: 0.5 }
    state_updates: { email.last_uid: "${result.last_uid}" }
    emit:
      - type: email.received
        each: ${result.emails}
        dedup_key: "email:${item.message_id}"
        payload: ${item}
```

| Field | Meaning | Default |
|---|---|---|
| `name` | The task's name: `[a-z][a-z0-9_]*`, unique across all tasks files. It appears in the automatic `task.<name>.succeeded` and `task.<name>.failed` events, in run records and in logs. | required |
| `trigger` | `{ kind: cron }`, `{ kind: event }` or `{ kind: manual }`. See [Triggers](../tasks/triggers.md). | required |
| `action` | One of [`shell`](../tasks/shell.md), [`connector`](../tasks/connector.md), [`wait`](../tasks/wait.md), [`sequence`](../tasks/sequence.md), [`llm`](../tasks/llm.md), [`decide`](../tasks/decide.md) or [`agent`](../tasks/agent.md). Templates in the action may use `secrets.<name>`. | required |
| `concurrency` | Runs of this task executing at the same time. The daemon's `workers` cap applies on top. | `1` |
| `timeout` | Wall-clock limit per attempt of active work. Time spent `waiting` does not count. When it expires the attempt is aborted and retried if `retry` allows. | `defaults.timeout`, normally `15m` |
| `retry.attempts` | Attempts a run may make, 1 to 100. Attempts belong to one run; `task.<name>.failed` is published once, after the last. | `1` |
| `retry.backoff` | `fixed` waits `base` between attempts; `exponential` doubles `base` on each attempt, capped at `max`. | `exponential` |
| `retry.base` | The first wait between attempts. | `30s` |
| `retry.max` | The longest wait between attempts. | `1h` |
| `budget.max_usd` | The most a run may spend on models, summed over all its attempts. | none |
| `emit` | Rules turning the result into events. See [Routing](../tasks/routing.md). Templates here may not use `secrets`. | none |
| `state_updates` | `<namespace>.<key>: value`, each part `[a-z0-9_-]+`. Values are templates over the result. Written after a successful run, in the same transaction as the emitted events. Templates here may not use `secrets`. | none |

The `retry` defaults come from `defaults.retry` in `agent.yaml` when the task has no
`retry`.

### How budgets combine

An `llm` or `decide` action with its own `budget.max_usd` is capped at the smaller of
its value and the task's. An `agent` action takes its own value, else
`defaults.agent.budget.max_usd`, and then the smaller of that and the task's. The
daily cap `budgets.daily_usd` applies on top of every per-run budget.

## Grammars

| What | Grammar | Examples |
|---|---|---|
| Duration | an integer and a unit: `ms`, `s`, `m`, `h`, `d` | `500ms`, `30s`, `15m`, `24h`, `7d` |
| Task name, provider name, `decide` question id | `[a-z][a-z0-9_]*` | `fetch_email`, `anthropic`, `kind` |
| Connector name | `[a-z][a-z0-9_-]*` | `email`, `github-prs` |
| State key | `<namespace>.<key>`, each part `[a-z0-9_-]+` | `email.last_uid` |
| Event type | dot-separated segments, each `[a-z0-9_-]+`, at most 8 | `email.received`, `task.publish_site.succeeded` |
| Event type pattern (triggers, `wait.for.type`) | an event type where a whole segment may be `*`, matching exactly one segment | `task.*.failed`, `email.*` |
| Secret name | `[a-zA-Z][a-zA-Z0-9_]*` | `ftp_pass`, `anthropic_api_key` |
| Cron schedule | 5, 6 or 7 space-separated fields (optional seconds first, optional year last), or a nickname such as `@hourly` | `*/2 * * * *`, `0 8 * * 1-5` |

An emitted event type, a manifest's `emits` entry and a poller's `event` take no
wildcard. Templates are `${ <JMESPath> }`; see [Templates](../tasks/templates.md).

## What `oa validate` checks on a tasks file

`oa validate <file>` needs no running daemon. On a tasks file alone it checks:

- The file parses as YAML and `tasks` is a non-empty list. No unknown key anywhere.
- Every name matches its grammar and is unique in the file. Validated from
  `agent.yaml`, names are also unique across all tasks files.
- Every duration, number and enumerated value is in range.
- A cron schedule parses, its time zone is known, and it fires at least once.
- An event trigger has exactly one of `type` or `type_any`, every pattern is
  well-formed, and `filter` is valid JMESPath.
- A task does not trigger on its own `task.<name>.succeeded` or `task.<name>.failed`.
- Every `${…}` template compiles. `secrets` appears only inside `action`, and only as
  `secrets.<name>`, never as a whole.
- Every `emit` type is concrete, `when` is valid JMESPath, and `each` is a single
  whole `${…}` template.
- Every `state_updates` key follows the grammar.
- A `sequence` has only `shell`, `connector` and `wait` steps, each with valid
  `when`.
- An `llm` action has `system` or `system_file` but not both, and no `${` in either.
- A `decide` action has at least one question, question ids follow the grammar, no
  question contains `${`, a `choice` has 2 to 255 labels, a `score` 2 to 10 levels.
- An `agent` action lists at least one tool kind, its `result.path` is relative and
  stays inside the workspace, `system_file` contains no `${`, and no connector appears
  twice in `mcp_servers`.

Validated from `agent.yaml`, which follows every tasks file and manifest it names,
these checks are added:

- An `llm` or `decide` action has a provider and a model, through its own fields or
  `defaults`; the provider exists in `providers`.
- A `decide` action's provider is of type `openrouter`.
- `batch: true` is only on an `anthropic` provider.
- Every model has a price: in the built-in table, in `pricing`, or by being on an
  `openrouter` provider. An `agent` action's `model`, when set, has a price.
- `system_file` and `result.schema` exist under the directory of `agent.yaml`.
- Every `mcp_servers` entry names a running-process connector with `transport: stdio`
  that lists the granted ops.
- A sandboxed `shell` action's `cwd` and binds do not expose the database, the socket,
  `agent.yaml` or the secrets file.
- An `agent` task whose workspace is a worktree of a repository names one its
  sandboxed agent program can see.

Issues are printed one per line as `<file>: <path>: <message>`; the command exits 1
when any check failed and 2 when it was given no file.

Some expressions are valid but almost certainly wrong. `oa validate` prints these as
`<file>: <path>: warning: <message>`, naming the task, and still exits 0; the daemon
logs the same warnings as `core.config_warning` when it starts and on every reload.
Warnings cover every `filter` and `when` (a post gate's too) and the expression inside
every `${…}` template, wherever a task holds one. They flag a comparison that:

- uses a bare `true`, `false` or `null`. JMESPath reads the bare word as a field name,
  so `payload.approved == true` is true when `approved` is missing and false when it is
  `true`. Write `` payload.approved == `true` ``.
- uses `"true"`, `"false"`, `"null"` or a number in double quotes. Double quotes make a
  field name too. Write `'true'` for the string, or `` `true` `` for the boolean.
- orders against a quoted number, as in `payload.amount > '100'`. JMESPath orders only
  numbers. Write `` payload.amount > `100` ``.

A `wait`'s `for.filter` is rendered as text before it is read as JMESPath, so it gets
two more warnings:

- a template used directly as a comparison operand, as in
  `payload.ok == ${event.payload.want}`. The rendered value lands unquoted: a string
  or `true` becomes a field name, and a number breaks the filter. Write
  `'${event.payload.want}'` for a string or `` `${event.payload.want}` `` for a number
  or a boolean.
- a filter that is not valid JMESPath, even with each template standing for a value.
  The wait would never match.

A comparison such as `payload.zip == '01234'` gets no warning: equality with a quoted
string is right when the field holds a string. A bare number such as
`payload.amount > 100` is an error, not a warning; the message suggests the backticks,
as in `` `100` ``.
