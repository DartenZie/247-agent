# Actions and the executor

The contracts the deterministic runners keep (`shell`, `connector`, `wait`, `sequence`),
the routing of a result (`emit`, `state_updates`), the `${…}` templating they share, and
the executor around them: attempts, retries, timeouts, recovery. Open it when touching
`packages/core/src/actions/{shell,connector,wait,sequence}.ts`, `expr/`,
`executor/executor.ts`, or the emit and template rules in `config/schema.ts`. The
model-backed runners are in [`model-actions.md`](model-actions.md) and
[`agent-action.md`](agent-action.md); what the user sees is under
[`../tasks/`](../tasks/index.md).

## The action context

Every runner is `(action, ctx) => Promise<JsonValue>` (`actions/types.ts`,
`ActionRunner`), one runner per kind in its own file, registered by kind. The runner
narrows `action` with its own zod schema, does the work, and returns the JSON result
the executor stores and routes. A thrown error fails the attempt with its message.

`ActionContext` carries: `run` (the run record, so `run.attempt` and `run.error` are
visible to a runner), `event` (the trigger event as the action should see it), `task`,
`signal` (aborted on timeout or daemon stop; a runner must stop what it started),
`log` (already tagged with `run_id`, `task`, `correlation_id`), `state` (a snapshot at
run start), `secrets` (only the names the task's templates reference, resolved for
this run), `scope` and `render`/`renderText`, and the optional ports: `connectors`,
`llm`, `agents`, `transcripts`, `sandbox` (`defaults.sandbox`), `sandboxHost`,
`suspend`/`resume` for waits. A port is absent when the core runs without the matching
component; a runner that needs one throws `NonRetryableError`.

`contextEvent()` (`executor/executor.ts`) decides what `event` is: for a `manual.run`
trigger with `payload.event`, the inner event's `type` and `payload` under the
`manual.run` event's own `id`, `correlation_id`, `parent_id`, `depth` and `ts`;
otherwise the trigger itself. So `oa run --event` replays a payload without changing
the chain it belongs to.

## Templates and expressions

`expr/template.ts` renders `${ <JMESPath> }` against the scope `{event, result, state,
secrets, env, run, item, steps}`:

- `result` exists only in `emit` and `state_updates`; `item` inside an `emit[].each`
  fan-out; `steps` inside a `sequence` (`withScope()` adds it); `run` is `{id, task,
  attempt, event_id, correlation_id, workspace}`, `workspace` being
  `<work_dir>/<run_id>` or `null` without an agent supervisor.
- `env` is the daemon's environment minus the variables that start with the `env`
  secrets backend's prefix (`daemon.ts`, `templateEnv()`); the `file` and
  `systemd-credentials` backends remove nothing.
- A string that is exactly one `${…}` renders to the expression's raw value
  (`renderValue`); text around or between templates makes a string, with non-strings
  JSON-encoded and `null` rendered empty (`stringifyValue`).
- `secrets` may appear only inside `action`, and only as `secrets.<name>`:
  `config/schema.ts` runs `checkTemplates(action, {secrets: true})` and the same with
  `{secrets: false}` on `emit` and `state_updates` ("secrets cannot be used here: they
  would be written to the store or an event"); `${secrets}` as a whole is refused
  everywhere.
- `trigger.filter`, `emit[].when`, a sequence step's `when` and a post gate's `when`
  are bare JMESPath (`expr/jmespath.ts`), evaluated with JMESPath truthiness; a filter
  that throws counts as no match and is logged. Event type patterns (`expr/glob.ts`)
  let `*` match exactly one dot-separated segment.

`oa validate` checks the syntax of every template and expression. Rendering happens at
run time against the run's scope; a template that fails to render fails the attempt.

## `shell`

`actions/shell.ts`. `cmd` is argv, run with `execa` and no shell; `cwd`, `env` values
and `cmd` render to strings; `stdin` is sent verbatim when a string, else as JSON.
`result` selects the outcome: `text_stdout` (default; one trailing newline stripped),
`json_stdout` (parse failure fails the attempt), `exit_code` (the number, never a
failure for a non-zero exit). In the first two modes a non-zero exit is `ShellError`
with the last 1024 characters of stderr. A spawn failure or a signal fails in every
mode. Each of stdout and stderr is kept up to 8 MiB. An abort sends SIGTERM, then
SIGKILL after 5 s. Unsandboxed, the action's `env` is added to the daemon's
environment; `user:` is not supported.

`sandbox` is the action's own, else `ctx.sandbox` (`defaults.sandbox`); `none` opts
out. The `post` gates of an `agent` action run through this runner with no `sandbox` of
their own, so the default applies to them.

### The bwrap argv

`actions/sandbox.ts`, `buildSandboxArgv()`, builds one bubblewrap command line:

- `--unshare-pid --unshare-ipc --die-with-parent --new-session`; the host's network
  stays shared (`--unshare-net` only through `extra_args`; the `network` allowlist
  exists on `acp` manifests only, [`security.md`](security.md)).
- `/usr`, `/lib`, `/lib64`, `/bin`, `/etc` read-only, symlinks among them recreated
  with `--symlink`; `--proc /proc --dev /dev --tmpfs /tmp`; `OA_HOME` and the daemon's
  Node prefix read-only, so `PATH` resolves the bundled tools and `node`.
- The protected set (`config/agent.ts`, `protectedPaths()`): the database, the
  socket, the `<socket>.net` directory, `agent.yaml` and a `file` backend's secrets file.
  Their directories become `--tmpfs` masks; a mask that would cover an OS directory or
  the install is skipped and the file itself is bound to `/dev/null` instead, so it
  never shows through a read-only mount.
- `--bind cwd cwd` is the only writable path; `ro_binds`/`rw_binds` add host paths at
  the same location; `--chdir <cwd or /tmp> --clearenv`, then `PATH` (the host's, or
  `/usr/local/bin:/usr/bin:/bin`), `HOME` = cwd, `LANG` if set, the action's `env`;
  `extra_args`; `--`. Without `cwd` the command runs in the private `/tmp` with
  `HOME=/tmp` and nothing else writable.

`oa validate` refuses a `cwd` or a bind that would show a protected file
([`config.md`](config.md)). The runtime directory, the state directory and other
processes are not reachable from inside.

## `connector`

`actions/connector.ts` renders `args` with `ctx.render` (whole templates keep raw
values) and calls `ctx.connectors.call(name, op, args, {signal, timeoutMs})`, default
timeout 60 s. The supervisor (`connectors/supervisor.ts`, `callTool()`) refuses an op
outside the manifest's `ops` before any call (`ops: []` allows all), an unknown name
(`NonRetryableError`), a non-`stdio` connector (`ConnectorOpError`), and a connector
that is not up (`ConnectorDownError`, retryable). The MCP result maps through
`toolResultToJson()`: `isError` → `ConnectorOpError` (non-retryable, message = the
text); else `structuredContent`; else one text block parsed as JSON when it parses, the
string otherwise; several texts → an array; none → `null`. Every call counts in
`oa_connector_ops_total{connector,op,result}` and the duration histogram.

## `wait`

`actions/wait.ts`. `for.type` is a type pattern; `for.filter` is rendered as a
template first (so `${event.correlation_id}` is the waiting run's own) and stored on
the wait record; the dispatcher (`bus/dispatcher.ts`) evaluates it as JMESPath over
each incoming event (minus `seq`), a throwing filter logging `wait.filter_error` and
not matching. Arming happens inside the suspend transaction, which also checks events
published after the run's trigger up to the dispatch cursor, so a reply that raced the
asking step re-queues the run on the spot. The result is the matched event (minus
`seq`); on timeout `on_timeout: succeed` returns `{timed_out: true}`, else
`WaitTimeoutError` (non-retryable). A wait without `timeout` waits forever. The
attempt timer is cleared on suspend and set again on resume, so waiting time never
counts against the task `timeout`. An event past `limits.max_event_depth` starts no run
but still ends a wait.

## `sequence`

`actions/sequence.ts`. Steps are `shell`, `connector` or `wait`, each with an optional
`when`; `steps[i]` is the result of step i (`null` when skipped) for later templates
and `when`s; the run result is `{steps: [...]}`. A `wait` step suspends with
`{step, steps}`; on resume the runner restarts at that index with the earlier results
and takes the wait's outcome without waiting again. The executor rebuilds
`ctx.resume` from the wait record on every attempt of the run, so a retry after a
resumed attempt failed starts again at the wait step with the same outcome; steps
before it are not re-run. A retry of an attempt that never waited starts at step 0.

## Routing: `emit` and `state_updates`

`executor/executor.ts`, `finish()`. After a successful attempt the executor renders
every `emit` rule and every `state_updates` value **before** opening the transaction;
a rule that cannot be rendered turns the outcome into a non-retryable failure, so only
`task.<name>.failed` is published and nothing else is emitted. Then, in one
transaction: the run's status, the `state_updates`, `task.<name>.succeeded` (payload =
the result) and the emitted events.

- `each` must be a single `${…}` (`config/schema.ts`); it renders to an array, one
  event per `item`; `null` emits nothing; anything else fails.
- `when` is JMESPath over `{event, result, state, env, run}`; falsy skips the rule.
- Emitted events carry `source: task:<name>`, the trigger event as `parent_id`, and so
  its `correlation_id` and `depth + 1`; a `dedup_key` collision is dropped and logged
  at debug.
- `task.<name>.failed` is published once, after the last attempt, with payload
  `{run_id, task, error, attempt}`.
- `bus/matcher.ts` never matches a task to an event whose `source` is its own
  `task:<name>`; the lifecycle events and every emitted event carry that source, which
  is the whole loop guard at the task level. The chain-level guard is
  `limits.max_event_depth` in the dispatcher.

## Attempts, retries, timeouts

The executor is a worker pool bounded by `workers` globally and `concurrency` per task
(default 1). A run is one or more attempts:

- `timeout` (task's, else `defaults.timeout`, 15m) bounds each attempt's active work;
  the timer aborts `ctx.signal`. Waiting time is excluded (above).
- `retry` (task's, else `defaults.retry`: `attempts: 1`, `exponential`, `base: 30s`,
  `max: 1h`): `fixed` waits `base`; `exponential` waits `min(base × 2^(attempt−1),
  max)`. Between attempts the run stays `running` with the attempt's error in
  `run.error`, which the next attempt sees (the agent runner puts it in the prompt).
- Retryable is the default. An error is final when it carries `retryable === false`
  (`NonRetryableError` in `actions/types.ts`, `BudgetExceededError`,
  `UnpricedModelError`, `ProviderUnavailableError` in `llm/errors.ts`,
  `ConnectorOpError`, `WaitTimeoutError`, `SecretError`). So: an attempt timeout, a
  connector that is down, a failed `post` gate and a missing or invalid RESULT.json are
  retried; a wait timeout, a missing secret, an unknown connector, an `isError` op
  result, an op outside `ops`, an unrenderable emit rule, a budget or price failure, a
  `max_tokens` or refusal stop, an agent policy violation or tool-call cap, and a
  missing task or runner are not.
- `budget.max_usd` is checked against the ledger sum of the whole run, so retries
  share one cap ([`model-actions.md`](model-actions.md)).

Secrets are resolved per attempt from the backend, only the names in
`task.secretNames` (collected by the matcher from the action's templates); a missing
one is `SecretError`, non-retryable, at run time and not at validate time.

## Recovery

On start the executor reads runs left `running`: one whose policy allows another
attempt is re-queued (a sequence continues from its last wait checkpoint), otherwise
it is failed as `interrupted: the daemon restarted while the run was in progress`;
`run.recovered` is logged. `waiting` runs stay waiting; one whose timeout already
passed ends immediately. A daemon stop during a backoff sleep leaves the run `running`
for the next start to handle. SIGTERM aborts attempts in flight through `ctx.signal`.

## Invariants a change must keep

- A runner never touches the store, the bus or an SDK: it reads `ctx` and returns a
  value. The executor owns transactions.
- Results and emitted payloads are JSON; secrets never appear in them, and
  `state_updates` and `emit` are rendered without the `secrets` scope.
- One run per `(task, event_id)` (`UNIQUE` in the store); attempts belong to the run.
- A new error that must not be retried extends `NonRetryableError` or sets
  `retryable = false`; everything else is retried by policy.
