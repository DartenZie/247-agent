# Your first task

In fifteen minutes you will run the daemon on your own machine, write a task that runs
on a schedule and publishes an event, write a second task that reacts to it, and use
the commands that show you what happened. No systemd, no secrets, no model.

You need a built checkout or an installed release (see [Install](install.md)) and two
terminal windows. The commands below assume `oa` and `247-agent-core` are on your
`PATH`; in a checkout, use `bin/oa` and `bin/247-agent-core` instead.

## 1. Make a place for it

Everything the daemon writes goes next to its configuration file, so one directory is
all it takes:

```sh
mkdir ~/oa-tutorial && cd ~/oa-tutorial
```

> [!NOTE]
> On macOS, keep this path short. The daemon listens on a Unix socket, and macOS limits
> socket paths to 104 bytes.

## 2. Write `agent.yaml`

This is the global configuration. Every key has a default, so the smallest useful file
says where the database and socket go, which tasks file to load, and how much to log.
Relative paths are relative to this file.

```yaml
db: state.db
socket: core.sock
tasks: tasks.yaml
log: { level: info }
```

## 3. Write two tasks

Save this as `tasks.yaml`:

```yaml
tasks:
  # Every five minutes: print a greeting and publish it as an event.
  - name: say_hello
    trigger: { kind: cron, schedule: "*/5 * * * *" }
    action:
      kind: shell
      cmd: ["bash", "-c", 'printf "hello, world (run %s)\n" "$1"', "--", "${run.id}"]
      result: text_stdout
    emit:
      - type: hello.greeted
        payload: { greeting: "${result}" }

  # Whenever a greeting is published: react to it.
  - name: echo_greeting
    trigger: { kind: event, type: hello.greeted }
    action:
      kind: shell
      cmd: ["bash", "-c", 'echo "someone said: $GREETING"']
      env: { GREETING: "${event.payload.greeting}" }
      result: text_stdout
```

What is in there:

- A **trigger** says when a task runs. `cron` takes the familiar five fields (minute,
  hour, day of month, month, day of week); `*/5 * * * *` is every five minutes. `event`
  runs the task once for every event of that type.
- An **action** says what the task does. `shell` runs a command given as a list of
  arguments, with no shell in between unless you ask for one, as the first task does
  with `bash -c`. `result: text_stdout` makes the command's output the task's result.
- `${…}` is a **template**, filled in before the command starts: `${run.id}` is this
  run's id, `${result}` the action's result, `${event.payload.greeting}` a field of the
  event that triggered the task.
- `emit` is **routing**: the first task's result becomes an event of type
  `hello.greeted`, which is what the second task listens for. The two tasks never
  mention each other.

## 4. Validate

`oa validate` checks the files without a running daemon: the schema, every template,
every cron expression.

```sh
oa validate agent.yaml
```

```
ok agent.yaml (tasks /home/you/oa-tutorial/tasks.yaml)
ok /home/you/oa-tutorial/tasks.yaml (2 tasks)
```

It followed `agent.yaml` to the tasks file and checked both. A mistake prints the file,
the path of the field and what is wrong, and exits with status 1.

## 5. Start the daemon

In this first window, run the daemon in the foreground:

```sh
247-agent-core --config agent.yaml
```

It logs one JSON object per line. The first few tell you what it loaded, that the
schedule is armed, and where it listens:

```json
{"ts":"2026-10-04T17:36:56.628Z","level":"info","msg":"core.config_loaded","files":"/home/you/oa-tutorial/tasks.yaml","tasks":2}
{"ts":"2026-10-04T17:36:56.628Z","level":"info","msg":"core.started","backlog_runs":0,"interrupted_runs":0,"resumed_runs":0,"waiting_runs":0}
{"ts":"2026-10-04T17:36:56.629Z","level":"info","msg":"cron.armed","task":"say_hello","schedule":"*/5 * * * *","next_run":"2026-10-04T17:40:00.000Z"}
{"ts":"2026-10-04T17:36:56.630Z","level":"info","msg":"api.listening","socket":"/home/you/oa-tutorial/core.sock"}
{"ts":"2026-10-04T17:36:56.630Z","level":"info","msg":"daemon.started","config_file":"/home/you/oa-tutorial/agent.yaml","db":"/home/you/oa-tutorial/state.db","socket":"/home/you/oa-tutorial/core.sock"}
```

Leave it running. Ctrl-C stops it.

## 6. Run the task by hand

In the second window, tell `oa` where the socket is, then start the task without
waiting for its schedule:

```sh
export OA_CORE_SOCKET=~/oa-tutorial/core.sock
oa run say_hello --wait
```

```
succeeded run_01M43ZV28DEK6X07KQFGD1X7R3 for say_hello
"hello, world (run run_01M43ZV28DEK6X07KQFGD1X7R3)"
```

`--wait` blocks until the run finishes and prints its result. Without it, `oa run` only
queues the run and tells you its id:

```sh
oa run say_hello
```

```
queued run_01M43ZV3S25A74KF0X40Q05N6B for say_hello (event evt_01M43ZV3S21ZZRCVA3C4QC2SAS)
```

> [!TIP]
> `oa run` works for any task, whatever its trigger, and skips the trigger's filter
> and the cron overlap check. It is the quickest way to try a task you just wrote.

## 7. See what happened

List the newest runs. The second task ran on its own each time, because the first one
published a `hello.greeted` event:

```sh
oa runs ls
```

```
run_01M43ZV3S830W3DABFFTD27YWB  echo_greeting  succeeded  2026-10-04T17:37:00.200Z     0.0s
run_01M43ZV3S25A74KF0X40Q05N6B  say_hello      succeeded  2026-10-04T17:37:00.194Z     0.0s
run_01M43ZV28NAKTKRD242KPS8RAM  echo_greeting  succeeded  2026-10-04T17:36:58.645Z     0.0s
run_01M43ZV28DEK6X07KQFGD1X7R3  say_hello      succeeded  2026-10-04T17:36:58.637Z     0.0s
```

Look at one run in full:

```sh
oa runs show run_01M43ZV3S25A74KF0X40Q05N6B
```

```
run         run_01M43ZV3S25A74KF0X40Q05N6B
task        say_hello
status      succeeded
event       2026-10-04T17:37:00.194Z  evt_01M43ZV3S21ZZRCVA3C4QC2SAS  manual.run  source=manual  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE
payload     {"task":"say_hello","event":{"type":"manual.input","payload":null}}
created     2026-10-04T17:37:00.194Z
started     2026-10-04T17:37:00.195Z
finished    2026-10-04T17:37:00.200Z  (took 0.0s)
result      "hello, world (run run_01M43ZV3S25A74KF0X40Q05N6B)"
```

Every run has a trigger event. A run you started by hand was triggered by a
`manual.run` event. Now list the events themselves:

```sh
oa events tail
```

```
2026-10-04T17:37:00.194Z  evt_01M43ZV3S21ZZRCVA3C4QC2SAS  manual.run  source=manual  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE
2026-10-04T17:37:00.200Z  evt_01M43ZV3S84QEVXCHC0GT48AM1  task.say_hello.succeeded  source=task:say_hello  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE  parent=evt_01M43ZV3S21ZZRCVA3C4QC2SAS
2026-10-04T17:37:00.200Z  evt_01M43ZV3S8BY7T115X29WNRPJ1  hello.greeted  source=task:say_hello  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE  parent=evt_01M43ZV3S21ZZRCVA3C4QC2SAS
2026-10-04T17:37:00.204Z  evt_01M43ZV3SCS15ZKPVJ79CJQ6QT  task.echo_greeting.succeeded  source=task:echo_greeting  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE  parent=evt_01M43ZV3S8BY7T115X29WNRPJ1
```

Read the chain from top to bottom: your `manual.run` started `say_hello`, which
published two events, the automatic `task.say_hello.succeeded` and your own
`hello.greeted`; the latter started `echo_greeting`, which published its own success.
All four share one `correlation` id, and each carries its `parent`. That is how you
trace anything the daemon did back to what caused it.

One event, with its payload:

```sh
oa events show evt_01M43ZV3S8BY7T115X29WNRPJ1
```

```
2026-10-04T17:37:00.200Z  evt_01M43ZV3S8BY7T115X29WNRPJ1  hello.greeted  source=task:say_hello  correlation=cor_01M43ZV3S2XD6BY92FR56YFXZE  parent=evt_01M43ZV3S21ZZRCVA3C4QC2SAS
payload: {"greeting":"hello, world (run run_01M43ZV3S25A74KF0X40Q05N6B)"}
```

## 8. Change the schedule without restarting

Edit `tasks.yaml` so the first task runs every minute:

```yaml
    trigger: { kind: cron, schedule: "* * * * *" }
```

Then ask the daemon to re-read its configuration:

```sh
oa reload
```

```
ok /home/you/oa-tutorial/agent.yaml
ok /home/you/oa-tutorial/tasks.yaml
reloaded: 2 tasks
```

A reload is all or nothing: if any file is invalid, the issues are printed, nothing
changes, and the exit status is 1. Now watch the schedule fire on its own:

```sh
oa events tail --type hello.greeted --follow
```

Within a minute a new line appears, then another every minute, until you press Ctrl-C.
`--type` takes an exact type or a pattern where `*` stands for one segment, so
`task.*.failed` watches every failure.

Stop the daemon in the first window with Ctrl-C when you are done. The database stays
in `~/oa-tutorial/state.db`; start the daemon again and every run and event is still
there.

## What you learned

- A task is a trigger, an action and routing; `oa validate` checks it before anything
  runs.
- Tasks never call each other. One publishes an event, another listens.
- `oa run <task> --wait` runs any task now and shows its result.
- `oa runs ls`, `oa runs show`, `oa events tail` and `oa events show` tell you what
  happened, and the correlation id ties it all together.
- `oa reload` applies configuration changes to a running daemon.

## Next

- [Your first workflow](first-workflow.md): a mailbox, one model call and a reply.
- [How it works](../concepts/how-it-works.md) for the ideas behind what you just saw.
- [Tasks](../tasks/index.md) for every trigger, action and routing option.
