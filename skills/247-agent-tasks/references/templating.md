# Templates and expressions

Two different things look alike; mixing them up is the most common config bug.

| Where | Syntax | Evaluated as |
|---|---|---|
| Any value in `action`, `emit[].payload`, `emit[].dedup_key`, `emit[].each`, `state_updates`, `wait.for.filter` (rendered first) | `${ <JMESPath> }` | template over the scope below |
| `trigger.filter`, `emit[].when`, sequence step `when` | bare JMESPath, no `${…}` | truthiness decides |

## Scope

| Name | What it is | Available in |
|---|---|---|
| `event` | The trigger event (`event.type`, `event.payload`, `event.correlation_id`, `event.id`, `event.source`). For `oa run --event f.json` the given event, under the `manual.run` event's ids | everywhere |
| `result` | The action's result | `emit`, `state_updates` only |
| `state` | KV snapshot at run start: `state.<namespace>.<key>` | everywhere |
| `secrets` | Secret values, only as `secrets.<name>` | `action` only |
| `env` | The daemon's environment (minus the secrets backend's variables) | everywhere |
| `run` | `{id, task, attempt, event_id, correlation_id}` | everywhere |
| `item` | Current element of an `emit[].each` fan-out | that emit rule |
| `steps` | Earlier step results in a `sequence` (`steps[0]`, `null` if skipped) | later steps |

Trigger `filter` sees the **whole event** (`payload.from`, `type`, `source`), not the
scope above. `emit.when` sees `{event, result, state, env, run}`.

## Rendering rules

- A string that is exactly one `${…}` yields the expression's **raw value**: a number
  stays a number, an object stays an object. `stdin: ${event.payload}` sends JSON.
- Text around or between templates makes a string; non-string values are JSON-encoded,
  `null` becomes empty.
- `shell.cmd`, `cwd` and `env` values render to strings.
- Inside YAML flow mappings `{ … }` quote the template, because `{` starts a nested map:
  `{ since_uid: "${state.email.last_uid}" }`. Block style needs no quotes.
- `emit[].each` must be a single whole `${…}` rendering to an array.

## JMESPath reminders

- String literals in single quotes: `payload.from == 'x@y.cz'`.
- Number and boolean literals in backticks: `` payload.approved == `true` ``,
  `` payload.uid > `10` ``.
- `||` and `&&` for logic, `!` for not, `contains(payload.subject, 'urgent')`,
  `starts_with(payload.from, 'bot@')`, `length(payload.items) > `0``.
- Fallback: `payload.summary || payload.error`.
- Missing keys evaluate to `null` (falsy), so `payload.kind == 'x'` is safe when
  `kind` is absent.

## Examples

```yaml
# Trigger filter: only the trusted sender's mail
trigger: { kind: event, type: email.received, filter: "payload.from == 'editor@example.com'" }

# Emit with fallback text (notify task)
args: { text: "[247-agent] ${event.type}: ${event.payload.summary || event.payload.error}" }

# Pass a template into a bash script safely, as an argument
cmd: ["bash", "-c", 'printf "hello (run %s)\n" "$1"', "--", "${run.id}"]

# Or via env
cmd: ["bash", "-c", 'echo "core said: $GREETING"']
env: { GREETING: "${event.payload.greeting}" }

# Approval correlation
for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
```

`oa validate` checks the syntax of every template and expression, rejects `secrets`
outside `action` and rejects `${secrets}` as a whole.
