# Templates and expressions

Two things in a tasks file look alike and are not: `${…}` templates, which fill in a
value, and bare JMESPath expressions in `filter` and `when`, which decide yes or no.
Mixing them up is the most common configuration mistake. This page has both.

## `${…}` templates

Anywhere a value is templated, `${ <expression> }` is replaced at run time. The
expression is JMESPath, a small query language for JSON: a dotted path reads a field,
`[0]` indexes a list, functions such as `join` and `length` transform values.

```yaml
args: { since_uid: "${state.email.last_uid}" }
payload: { kind: "${result.kind}", email: "${event.payload}" }
text: "Site change ready: ${event.payload.summary}\nApprove?"
cmd: ["bash", "-c", 'printf "hello (run %s)\n" "$1"', "--", "${run.id}"]
```

### What you can reach

| Name | What it is | Available |
|---|---|---|
| `event` | the event that triggered the run: `event.type`, `event.payload`, `event.correlation_id`, `event.id`, `event.source` | everywhere |
| `result` | the action's result | `emit` and `state_updates` only |
| `state` | the state store, as it was when the run started: `state.<namespace>.<key>` | everywhere |
| `secrets` | secret values, only as `secrets.<name>` | inside `action` only |
| `env` | the daemon's environment variables | everywhere |
| `run` | `run.id`, `run.task`, `run.attempt`, `run.event_id`, `run.correlation_id`, `run.workspace` | everywhere |
| `item` | the current element of an `emit … each` fan-out | that rule |
| `steps` | the results of earlier steps in a `sequence`: `steps[0]`, `null` when skipped | later steps |

With the `env` secrets backend, variables carrying its prefix are removed from `env`.
With `systemd-credentials`, `CREDENTIALS_DIRECTORY` is removed. A template cannot read
a secret around the rule, and an unsandboxed `shell` command starts from the same
reduced set.

### How a template renders

- A string that is **exactly one** `${…}` yields the expression's raw value: a number
  stays a number, an object stays an object, a list stays a list. `payload: ${item}`
  publishes the object; `stdin: ${event.payload}` sends JSON.
- Text around or between templates makes a **string**. Non-string values are JSON
  encoded, `null` becomes empty.
- `shell` `cmd`, `cwd` and `env` values always render to strings.
- Keys of an object are never templated, only values.
- A missing field is `null`, never an error: `${event.payload.missing}` renders empty
  in text and `null` as a whole value.

> [!WARNING]
> Inside a YAML flow mapping, the one written with braces, quote the template:
> `{ since_uid: "${state.email.last_uid}" }`. Unquoted, the `{` of `${` would start a
> nested map and the file would not parse. Block style needs no quotes.

### Where templates are not allowed

- `system` and `system_file` of an `llm` action, `system_file` of an `agent` action,
  and the `questions` of a `decide` action are static, so they can be cached and so
  inbound content cannot rewrite them. Put dynamic text in `input`, `prompt` or
  `state`.
- `secrets` may appear only inside `action`, only as `secrets.<name>`, never as a whole.
  `oa validate` refuses it anywhere else.

## `filter` and `when`: bare expressions

A trigger `filter`, an `emit` rule's `when`, a `sequence` step's `when` and an `agent`
gate's `when` are JMESPath expressions written directly, without `${…}`. Their result
is read for truth: `null`, `false`, an empty string, an empty list and an empty object
are false; everything else, including `0`, is true.

```yaml
trigger: { kind: event, type: email.received, filter: "payload.from == 'editor@example.com'" }
emit:
  - type: email.classified
    when: "result.kind != 'ignore' && result.confidence > `0.7`"
```

A trigger `filter` sees the **whole event**: `type`, `source`, `payload`,
`correlation_id`. `when` sees `{ event, result, state, env, run }`, and inside a
sequence also `steps`.

One exception: `for.filter` on a [`wait`](wait.md) is first rendered as a template
against the waiting run, and the rendered text is then evaluated as an expression over
each incoming event. That is how `payload.correlation_id == '${event.correlation_id}'`
works.

## JMESPath in five minutes

| You want | Write |
|---|---|
| a field | `payload.from`, `payload.body.repository.full_name` |
| a string comparison | `payload.from == 'editor@example.com'` (single quotes) |
| a number or boolean comparison | `` payload.uid > `10` ``, `` payload.approved == `true` `` (backticks) |
| and, or, not | `a && b`, `a \|\| b`, `!a` |
| a fallback | `payload.summary \|\| payload.error` |
| text search | `contains(payload.subject, 'urgent')`, `starts_with(payload.from, 'bot@')` |
| a list's length | `` length(payload.items) > `0` `` |
| the first element | `payload.items[0]` |
| filter a list | `result.entries[?type == 'file']` |
| join strings | `join(', ', payload.missing)` |
| a number as text | `to_string(payload.number)` |

Numbers and booleans in backticks are JSON literals; forgetting them compares against a
field named `true`, which is `null`, so the comparison is always false.

## What `oa validate` checks

Before the daemon runs anything, `oa validate` compiles every template and every
expression and reports the file, the path and the mistake:

- a template that does not parse: an unterminated `${`, an empty `${}`, invalid
  JMESPath inside it;
- a `filter` or `when` that is not valid JMESPath;
- `secrets` outside an action, or used as a whole;
- an `each` that is not a single `${…}`;
- a `${…}` inside a static system prompt or a `decide` question.

It cannot know what an event will contain, so a path that is misspelt renders `null`
at run time. Test the task with a real payload: `oa run <task> --event sample.json
--wait` shows the rendered result, and `oa emit <type> sample.json` tests the trigger
and the filter too.
