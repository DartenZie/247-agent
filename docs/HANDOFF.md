# Handoff: finish the non-LLM path end to end

Goal: every task in `docs/examples/orchestra-website.yaml` that does not call a model
(`fetch_email`, `approve_general_change`, `publish_site`, `notify`) runs unattended on a
real daemon, with a fake email/chat connector in tests. No `llm`/`agent` runner yet.

Read `docs/ARCHITECTURE.md` first (§3, §5.1, §5.4–5.7, §6, §10) and the status paragraph
in §14. `CLAUDE.md` has the rules and commands. Uncommitted work is in the tree; commit
it first as one change ("Add daemon, socket API, oa run/emit").

## What exists (all tested, `npm test` = 122 green)

- Config: `packages/core/src/config/` (zod schemas, `agent.yaml`, `oa validate`).
- Store: SQLite `events`, `runs`, `cursors` (`packages/core/src/store/`).
- Bus: publish + dedup + depth guard, dispatcher, matcher, manual runs (`src/bus/`).
- Scheduler: cron → `cron.tick` events (`src/scheduler/`).
- Executor: worker pool, per-task concurrency, timeouts, lifecycle events, recovery
  (`src/executor/executor.ts`). Only the `shell` runner exists (`src/actions/shell.ts`).
- Daemon + socket API + client (`src/daemon.ts`, `src/main.ts`, `src/api/`).
- CLI: `oa validate | run | emit` (`packages/cli/src/`).

## Gaps, in the order to close them

1. **`${…}` templating** (`src/expr/template.ts`). JMESPath inside `${…}` against
   `{event, result, state, secrets, env, item, run, steps}`. Whole-string template →
   the raw value (so `stdin: ${event.payload}` stays JSON); mixed string → stringified.
   Apply to `shell` (`cmd`, `cwd`, `env`, `stdin`) and every later runner. Extend
   `ActionContext` with `state`, `secrets`, `render()`.
2. **`emit` routing** in `Executor.finish`: `type`, `when` (JMESPath), `each` + `item`,
   `dedup_key`, `payload`; publish with `source: task:<name>`, `parent_id: run.event_id`.
   Schema it in `config/schema.ts` (currently `z.unknown()`).
3. **State KV**: `state` table + `store/state.ts`, `GET/PUT /v1/state/{ns}/{key}`,
   `state_updates` applied after success, `${state.…}` in templates.
4. **Secrets**: `secrets.backend: env | file | systemd-credentials`, resolved by name at
   run time into `ctx.secrets` only. Never in DB, logs or event payloads (assert in tests).
5. **`retry`** (attempts, backoff, base) in the executor; retries are attempts of the same
   run; `task.<name>.failed` only after the last attempt. Recover `running` runs by policy.
6. **`connector` action + supervisor** (`src/connectors/`): manifest schema
   (`connectors.d/*.yaml` or a `connectors:` list), spawn with `OA_CORE_SOCKET`,
   `OA_CONNECTOR_NAME`, `OA_CONFIG_JSON`, restart with backoff, one MCP stdio client
   per connector, `op` = tool call. Tests use a fake MCP server script, never the network.
   Add `packages/connector-sdk` helpers (`emitEvent`, state get/put, MCP boilerplate).
7. **`wait`** (run → `waiting`, resumes on a matching event, survives restart, `timeout`
   fired by the scheduler) and **`sequence`** (`steps[i]` in templates, `when`).
8. Merge `tasks.d/*.yaml` (dup-name check across files) and read `connectors.d/`.

Each step: schema + runner/module + tests next to code + ARCHITECTURE §14 status line.

## Conventions and gotchas

- Everything through events; no task-to-task calls; no LLM in control flow.
- One runner per file under `src/actions/`; runner narrows `action` with its own zod schema.
- `Logger` fields are scalars only. Put ids in logs, never payloads.
- Executor: a `manual.run` trigger presents `payload.event` as the context event
  (`contextEvent`). `runTask` may return the run already `running`.
- zod 4: use `.prefault({})` for nested objects with inner defaults.
- macOS Unix socket paths max 104 bytes; tests must use short temp dirs.
- `vitest.config.js` aliases `@online-agent/core` to sources; no build needed for tests.
- Lint is strict (`strictTypeChecked`); run `npm run lint` before finishing.

## Done when

- `oa validate docs/examples/*.yaml` passes.
- An integration test starts the daemon with a fake email connector (emits
  `email.received`), a fake chat connector (`ask`/`send`, emits `chat.reply`), and
  `publish_site` replaced by a shell `echo`; a `manual.run` of `fetch_email` ends with
  `publish_site` succeeded and `notify` called, with one correlation id throughout.
- No secret value appears in `state.db`, logs or any event payload in that test.
