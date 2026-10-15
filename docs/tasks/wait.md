# `wait`

Pause the run until a matching event arrives. This is how a human gets into the loop:
ask a question on chat, wait for the answer, act on it. The run holds no worker while
it waits, survives a restart of the daemon, and resumes the moment the event is
published.

## The smallest example

```yaml
tasks:
  - name: await_approval
    trigger: { kind: event, type: site.change_ready }
    action:
      kind: wait
      for:
        type: chat.reply
        filter: "payload.correlation_id == '${event.correlation_id}'"
      timeout: 24h
      on_timeout: fail
```

`for.type` is the event type to wait for, with `*` allowed for one segment as in a
trigger. `for.filter` narrows it down. The result of the action is the matched event,
so `${result.payload.approved}` is available to `emit` afterwards.

On its own, a `wait` task only listens. In practice the question and the wait go
together in a [`sequence`](sequence.md), so the reply can be matched to the question
that was asked:

```yaml
action:
  kind: sequence
  steps:
    - kind: connector
      connector: chat
      op: ask
      args: { text: "Publish ${event.payload.summary}?", correlation_id: "${event.correlation_id}" }
    - kind: wait
      for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
      timeout: 24h
    - kind: shell
      when: "steps[1].payload.approved == `true`"
      cmd: ["git", "push", "origin", "HEAD:main"]
```

## Matching the right event

`for.filter` is special: it is rendered as a template first, against the waiting run's
own scope, and the rendered text is then evaluated as a JMESPath expression against
every incoming event. So `${event.correlation_id}` becomes the id of the event that
started this run, and the filter reads: an event whose payload carries that id.

The daemon compares the value as data. It never reads the value as part of the
expression, so a name with an apostrophe in it, or a value crafted to look like
JMESPath, matches only an event that carries exactly that value. Write the template
where its value belongs: `'${event.payload.name}'` compares as a string,
`` `${event.payload.min}` `` as the number or boolean it holds, and a bare
`${event.payload.min}` as the value's own type. `for.filter` cannot use `secrets`,
because the rendered filter is stored with the run.

> [!WARNING]
> Always match on the correlation id, never on "the next reply". Two questions can be
> open at once, and the wrong answer would resume the wrong run. The chat connector's
> `ask` operation takes the id and puts it in the reply for exactly this reason.

An event published after the run started but before the wait was armed is checked
too, so a reply that races the question is not lost.

## Timeouts

`timeout` is how long to wait; without it the run waits indefinitely. When it passes,
`on_timeout` decides:

- `fail`, the default: the run fails without retry and `task.<name>.failed` is
  published, so your notify task hears about it.
- `succeed`: the run continues with `{ timed_out: true }` as the result.

The task's own `timeout` bounds active work only; time spent waiting does not count
against it.

If the daemon was stopped and the wait's timeout passed meanwhile, the run ends as soon
as the daemon starts again.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `for.type` | yes | | the event type to wait for; `*` matches one segment |
| `for.filter` | no | | a template rendered against this run, then a JMESPath expression over each incoming event |
| `timeout` | no | wait indefinitely | how long to wait |
| `on_timeout` | no | `fail` | `fail` the run without retry, or `succeed` with `{ timed_out: true }` |
