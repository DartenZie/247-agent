# Triggers

A trigger says when a task runs: on a schedule, when an event arrives, or only when you
start it by hand. Whatever the trigger, `oa run <task>` starts the task on demand.

## `cron`: on a schedule

```yaml
trigger: { kind: cron, schedule: "*/2 * * * *", tz: Europe/Prague, overlap: skip }
```

A cron schedule is five fields separated by spaces: minute, hour, day of month, month,
day of week. `*` means every, `*/2` every second one, `0 8 * * 1-5` is 08:00 on
weekdays. Six fields add seconds at the front, seven add a year at the end; both fire
on second boundaries rather than minutes. Nicknames such as `@hourly` and `@daily`
work too. `oa validate` rejects a schedule that can never fire.

`tz` is a time zone name such as `Europe/Prague` or `UTC`; without it the daemon's own
zone applies.

When the clocks change for daylight saving time, a schedule that names fixed hours
(`30 2 * * *`) runs once a day. In autumn it runs only in the first pass of the hour
that repeats. In spring, a run in the hour that is skipped moves one hour later on the
wall clock: 02:30 runs at 03:30. A schedule whose hour field is `*` (`*/30 * * * *`,
`@hourly`) keeps its pace in real time and also runs in the repeated hour.

Each tick publishes a `cron.tick` event with `payload: { task, scheduled_at }` and a
`dedup_key` of `cron:<task>:<scheduled_at>`, and one run starts from it. With
`overlap: skip`, the default, a tick is dropped while a run of the task is still queued,
running or waiting; `overlap: allow` starts another run anyway.

### Ticks missed while the daemon was down

A tick that falls while the daemon is stopped, for example during an upgrade or after a
crash, does not run. When the daemon starts again, it publishes one `cron.missed` event
for each cron task that missed at least one tick, and logs a `cron.missed` warning:

```json
{ "task": "backup", "missed": 1, "first_missed": "2026-10-04T03:00:00.000Z",
  "last_missed": "2026-10-04T03:00:00.000Z", "run": false }
```

To make a task run once at startup after it missed ticks, set `missed: run_once`:

```yaml
trigger: { kind: cron, schedule: "0 3 * * *", missed: run_once }
```

The task then gets one `cron.tick` for the last missed tick, with `catch_up: true` in
the payload, however many ticks it missed. `overlap` applies to this tick as to any
other. The default, `missed: skip`, runs nothing. To be told about a skipped tick, give
another task an event trigger on `cron.missed`. You can also run the task by hand with
`oa run <task>`.

The daemon counts missed ticks from the last tick it published, or from when it last
loaded the task. On the first start after an upgrade, and for a task that is new to
the daemon, nothing is reported.

## `event`: when something happens

```yaml
trigger:
  kind: event
  type: email.received
  filter: "payload.from == 'editor@example.com'"
```

One run starts per matching event. Give exactly one of `type` or `type_any`:

```yaml
trigger:
  kind: event
  type_any: [task.publish_site.succeeded, "task.*.failed", budget.exceeded]
```

An event type is dot-separated lowercase segments (`email.received`,
`task.publish_site.succeeded`), at most eight. In a trigger, `*` stands for exactly one
segment: `task.*.failed` matches `task.publish_site.failed` but not `task.failed` or
`task.a.b.failed`. There is no `**` and no partial wildcard like `email.*ed`.

### Filters

`filter` is a JMESPath expression evaluated against the whole event, not only its
payload. JMESPath is a small query language for JSON: `payload.from` reads a field,
`payload.from == 'x@y.cz'` compares it, `contains(payload.subject, 'urgent')` searches
in it. The run starts when the result is truthy. `null`, `false`, an empty string, an
empty list and an empty object are false; everything else, including `0`, is true.

Put every cheap relevance check here: the sender, a label, a branch name. A filter
costs nothing and runs before any model. A filter that throws counts as no match and is
logged by the daemon.

> [!TIP]
> Filters are bare JMESPath, not `${…}` templates. Compare numbers and booleans with
> backtick literals: `` payload.approved == `true` ``, `` payload.uid > `10` ``.
> `oa validate` warns when a filter compares with a bare `true` or orders against a
> quoted number. The [Templates](templates.md) page has more examples.

### What a task never triggers on

Every event a task's runs publish, including `task.<name>.succeeded` and
`task.<name>.failed`, carries the source `task:<name>`, and a task never matches events
from that source. So a `notify` task listening on `task.*.failed` cannot loop on its
own failure. `oa validate` also refuses a trigger that names the task's own lifecycle
event outright.

## `manual`: only by hand

```yaml
trigger: { kind: manual }
```

Nothing starts the task but `oa run`. Use it for maintenance jobs: a rebuild, a
one-off import, a replay.

### Declare the params a manual task needs

A manual task that reads values from `event.payload` can declare them under `params`.
The daemon then checks every `oa run` of the task before it queues the run:

```yaml
tasks:
  - name: greet
    trigger:
      kind: manual
      params:
        name: { type: string, description: who to greet }
        age: { type: integer, required: false }
        env: { enum: [staging, prod], default: staging }
    action:
      kind: shell
      cmd: ["echo", "Hello ${event.payload.name} on ${event.payload.env}"]
```

```sh
oa run greet -p name=Ada -p age=36 --wait
oa run greet --payload params.json --wait
```

The daemon refuses the run, and names each problem, when a required param is missing,
when a value does not have the declared type or is not in the `enum`, or when the
payload has a key that is not declared (a misspelled name). A param with a `default`
gets that value when it is not given. A string value is converted to the declared type,
so `-p age=36` gives the integer 36 and `-p loud=true` the boolean `true`. A task
without `params` takes any payload.

## `oa run` works on every task

Whatever its trigger, any task can be started by hand:

```sh
oa run fetch_email --wait
oa run classify_email --event mail.json --wait
```

This publishes a `manual.run` event and starts one run from it. Trigger filters and the
cron overlap rule do not apply, and manual runs are never deduplicated; the task's
`concurrency` and the global `workers` cap still do. With `-p key=value` or
`--payload <file>`, the action sees the given values as `event.payload`. With `--event`, the action sees the
file's `type` and `payload` as its event, under the manual run's ids, so you can replay
a real email through a task to test it. `oa emit <type> payload.json` is the other
tool: it publishes the event itself, so the trigger and the filter are exercised too.
See [the CLI reference](../reference/cli.md).

## Fields

### `cron`

| Field | Required | Default | Meaning |
|---|---|---|---|
| `schedule` | yes | | 5, 6 or 7 space-separated fields, or a nickname such as `@hourly` |
| `tz` | no | the daemon's zone | an IANA time zone name |
| `overlap` | no | `skip` | `skip` drops a tick while a run of the task is queued, running or waiting; `allow` starts another run |

### `manual`

| Field | Required | Default | Meaning |
|---|---|---|---|
| `params` | no | none: any payload | a map from param name (lower case letters, digits, `_`) to its declaration |

Each param:

| Field | Required | Default | Meaning |
|---|---|---|---|
| `type` | no | `string` | `string`, `number`, `integer`, `boolean`, `object` or `array` |
| `required` | no | `true`, or `false` with a `default` | whether `oa run` must give the param |
| `default` | no | | the value when the param is not given; must have the declared type |
| `enum` | no | | the only values allowed; each must have the declared type |
| `description` | no | | what the param is for |

### `event`

| Field | Required | Default | Meaning |
|---|---|---|---|
| `type` | one of the two | | an event type, with `*` for exactly one segment |
| `type_any` | one of the two | | a list of such types; any match starts a run |
| `filter` | no | | JMESPath over the whole event; a truthy result starts the run |

### `manual`

No fields.
