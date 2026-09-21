---
name: 247-agent-tasks
description: "Write, edit and review 247-agent task definitions (the `tasks:` YAML files the daemon runs). Use this whenever the user wants a new workflow or automation on the 247-agent daemon, wants to change a trigger (cron, event, manual), an action (`shell`, `connector`, `wait`, `sequence`, `llm`, `decide`, `agent`), an `emit` routing rule, `state_updates`, a `${…}` template or a JMESPath `filter`/`when`, or asks why a task never runs or emits the wrong thing. Also use it when the user says \"add a task\", \"run X every N minutes\", \"when an email arrives do Y\", \"approval gate\", \"chain these steps\", or edits any file under `tasks.d/`, `tasks.yaml` or `docs/examples/*.yaml`."
---

# 247-agent tasks

A task is one **trigger**, one **action** and the **routing** of its result into new
events. Tasks never call each other: a task that should run "after `fetch_email`"
triggers on an event that `fetch_email` emits (or on the automatic
`task.fetch_email.succeeded`). That decoupling is what keeps a config composable, so
never invent a way for one task to reference another by name.

`oa` below means the CLI. In this repo it is `node packages/cli/dist/main.js` (after
`npm run build`, or `npm run oa --`); in production it is the installed `oa` binary.

## Workflow

1. **Locate the tasks file.** `agent.yaml` names it under `tasks:` (a file, a directory
   of `*.yaml`, or a list). Task names must be unique across all of them. In this repo
   the reference workflow is `docs/examples/website-updates.yaml`; the smallest
   runnable example is `docs/examples/hello-world/hello-world.yaml`.
2. **Decide the tier before writing anything.** If the step can be done by a command or a
   connector operation, it is `shell` or `connector`. A model is called only inside a
   `decide` (typed questions, probabilities out, no text), an `llm` (one call, JSON out)
   or an `agent` (tool loop in a worktree) action, and only where judgement is needed.
   Filtering, dedup, routing, retries and publishing are never model work. For
   `decide`/`llm`/`agent` specifics, read the `247-agent-model-actions` skill.
3. **Put relevance checks in the trigger `filter`**, not in a prompt or a script. The
   filter is a bare JMESPath over the whole event (`payload.from == 'x@y.cz'`), it is
   cheap, and a non-match costs nothing.
4. **Write the task** using the field reference in `references/task-reference.md` and
   the templating rules in `references/templating.md`. Copy a shape from
   `references/patterns.md` when one fits (poll cursor + fan-out, approval gate,
   notify on failure, stand-in for a model step).
5. **Route the result with `emit`.** Every task already emits
   `task.<name>.succeeded|failed`; add domain events (`email.received`,
   `email.classified`) so that other tasks can react without knowing who produced
   them. Put `dedup_key` on anything that can be fetched twice.
6. **Validate, then exercise it.**

   ```
   oa validate <tasks file or agent.yaml>
   oa run <task> --wait                       # manual trigger, bypasses filter and overlap
   oa run <task> --event sample.json --wait   # replay a real payload through the task
   oa emit <type> payload.json                # test an event trigger + filter end to end
   ```

   `oa validate` checks schema, template syntax, JMESPath syntax, cron syntax, that
   `secrets` appear only in actions, and that no task triggers on its own lifecycle
   event. The daemon does not need to run for `validate`. For run inspection and
   debugging, use the `247-agent-operate` skill.

## Rules that the validator or the runtime will enforce

- Names: tasks `[a-z][a-z0-9_]*`; state keys `<namespace>.<key>`, each `[a-z0-9_-]+`.
- Durations: `500ms`, `30s`, `15m`, `24h`, `7d` (integer + unit, nothing else).
- `event` trigger: exactly one of `type` or `type_any`; `*` matches one dot-separated
  segment (`task.*.failed`). A task never matches its own `task.<name>.*` events nor
  events whose `source` is `task:<name>`.
- `cron` trigger: one run per tick; a tick is skipped while a run of the task is
  queued, running or waiting unless `overlap: allow`. Missed ticks are not replayed.
- `shell` steps that run untrusted code (a build or test of something an agent edited)
  get `sandbox: bwrap`; publishing steps holding secrets stay `sandbox: none`.
- `shell.cmd` is argv, no shell. Use `["bash", "-c", "…"]` when you need pipes or `&&`,
  and pass templated values through `env` or trailing args rather than interpolating
  them into the script text.
- `secrets.<name>` is allowed in `action` only, never in `emit` or `state_updates`, and
  never as a whole (`${secrets}`). Secret values never reach the DB, logs or events.
- `emit[].each` must be a single `${…}` that renders to an array; `null` emits nothing.
- Inside a YAML flow mapping (`{ … }`) quote templates: `{ since_uid: "${state.email.last_uid}" }`.
- `filter` and `when` are bare JMESPath (no `${…}`); compare numbers and booleans with
  backticks: `` payload.approved == `true` ``.
- `state_updates` and `emit` apply only after success, in one transaction with the
  lifecycle event. A rule that cannot be rendered fails the run without retry.

## What is runnable today

`shell`, `connector`, `wait`, `sequence`, `llm`, `decide` and all three trigger kinds run
end to end. `agent` validates (only `kind` is checked) but has no runner, so a run of one
fails with "no runner". When a workflow needs an agent step now, keep the real `agent`
task in the file for the intended shape and, for testing, use the stand-in pattern in
`references/patterns.md` (a `shell` task with the same trigger and `emit`); the same
stand-in keeps a model out of any test.

## Review checklist

Before declaring a task done, check:

- Could the model step be a filter, a script or a connector op instead? If yes, do that.
- Does every fetched item get a `dedup_key`? Does a poll keep its cursor in `state`?
- Is there a `notify`-style task on `task.*.failed` (and `budget.exceeded`) so failures
  are seen?
- Are timeouts and `retry` right for the action? Timeouts and connector-down are
  retried; wait timeouts, missing secrets, `isError` op results and unrenderable `emit`
  rules are not.
- `concurrency: 1` for anything that touches a shared checkout or a cursor.
- `oa validate` passes on the file **and** on `docs/examples/*.yaml` plus
  `docs/examples/connectors.d/*.yaml` if you touched anything shared.

Source of truth when in doubt: `docs/ARCHITECTURE.md` §3, §5, §5.8 and
`docs/USER-GUIDE.md` §4–§5 in this repo.
