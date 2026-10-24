# Configuration

How the three configuration sources are read, validated, cross-checked and reloaded, and
the seam every setting must pass through. Open this when touching
`packages/core/src/config/`, `oa validate`, or anything that reads a value from
`agent.yaml`. The user-facing key tables are `docs/reference/agent-yaml.md`,
`docs/reference/task.md` and `docs/reference/manifest.md`.

## Three sources, one tree

| Source | Schema | Where it is named |
|---|---|---|
| `agent.yaml` | `AgentFile` in `config/agent.ts` (strict at every level; an empty file parses as `{}`) | `--config`, default `/etc/247-agent/agent.yaml` |
| tasks files | `TasksFile` in `config/schema.ts`: `tasks: [Task…]`, at least one | `tasks:` in `agent.yaml`, default `tasks.yaml`; a file, a directory, or a list of both |
| connector manifests | `ConnectorManifest` in `config/connector.ts` | `connectors:` in `agent.yaml`: files, directories, or inline manifest objects; default `[]` |

`config/load.ts` expands a directory to its `*.yaml`/`*.yml` files in name order, merges
tasks files in file order and refuses a task name defined twice (`duplicate task name
"<n>" (also defined in <file>)`, on the later file) and a connector name defined twice
(inline manifests first). At least one tasks file must be found (`no tasks files
found`). Pollers are checked against their target connector here too (unknown, serves
no ops, op not in `ops`).

Relative paths resolve against the directory of `agent.yaml`: `db`, `socket`, every
`tasks` and string `connectors` entry, `defaults.agent.work_dir`, `secrets.path` and
`secrets.dir`, and every `system_file` and `result.schema` of an action. A manifest's
`cwd` resolves against the manifest file. `work_dir` unset means `work/` next to the
database (`parseAgent`); set, it resolves against the `agent.yaml` directory, not the
database's.

Every schema is `z.strictObject`: an unknown key is an error, which is what keeps a typo
from silently becoming a default. The exceptions are `config` and `env` of a manifest
(free-form, the connector's own) and `output_schema` of an `llm` action.

## Each action kind validates itself

`config/schema.ts` composes `Action` as a discriminated union on `kind` from the schemas
each runner exports (`ShellAction` from `actions/shell.ts`, `LlmAction` from
`actions/llm.ts`, and so on). The runner file owns its fields, their defaults and their
refinements; the schema file owns the task envelope (`name`, `trigger`, `concurrency`,
`timeout`, `retry`, `budget`, `emit`, `state_updates`) and the checks that span fields.
`on_failure` is accepted as `z.unknown()` and read by nothing; it is not documented.

## What `oa validate` checks

`packages/cli/src/commands/validate.ts` runs `checkConfigFile` (`config/check.ts`) on
every argument and prints `ok <file> (<summary>)` or `<file>: <path>: <message>` per
issue; exit 1 when any file failed. The daemon does not need to run. File kind: a
top-level `tasks` list of objects is a tasks file; `name` plus `exec` or `builtin` is a
manifest; anything else is an `agent.yaml`, whose tasks files and manifests are then
checked as well.

Checks, by where they live. The message texts are literal in the code; the user page
`docs/reference/task.md` lists them in user terms.

**Schema refinements** (`config/schema.ts`, `connector.ts`, `agent.ts`, `llm/config.ts`,
`retention.ts`, each runner's action schema): strict keys, enums, name regexes
(`[a-z][a-z0-9_]*` for tasks, providers and question ids; `[a-z][a-z0-9_-]*` for
connectors; `<ns>.<key>` for state keys), durations (`\d+(ms|s|m|h|d)`), cron
schedules through croner (5, 6 or 7 fields) and `tz` through `Intl`, event types and
patterns (`expr/glob.ts`: at most 8 segments of `[a-z0-9_-]+`, `*` one whole segment,
no wildcard where a concrete type is emitted), JMESPath compilation of `filter` and
`when`, template compilation everywhere a template may appear, `secrets` only as
`secrets.<name>` and only inside `action`, the self-trigger rule (`a task never triggers
on its own "<pattern>" event`), `each` as a single whole template, exactly one of
`type`/`type_any`, exactly one of `exec`/`builtin`, the manifest refinements per
transport (`health` only on an effective `stdio` process; `sandbox` other than `none`
only on `acp`; `acp` with empty `ops`/`emits` and no `config`; `managed_by: systemd`
not on a built-in or an `acp`; `socket` only with `managed_by: systemd` and `stdio`),
`api_key` exactly one secret reference, `headers` and manifest `config`/`env` using
only `${secrets.<name>}` and `${env.<VAR>}`, `batches.poll` within 1s..1h, `retention`
durations with `runs` and `ledger` at least 1d and `ledger` not outliving `runs`,
`pricing` entries for unknown models carrying `input` and `output`, `network.allow`
entries as `host[:port]`, `network` needing `backend: bwrap` and no `--share-net`.

**Load** (`config/load.ts`): unreadable file or directory, YAML syntax, no tasks file, duplicate
task or connector names across files, a poller's target connector and op.

**Cross-checks** (`config/crosscheck.ts`; also run at daemon start and on every reload):

- `checkLlmTasks`: every `llm`/`decide` task has a provider (its own or the default) that
  exists in `providers:`; a `decide` provider is of type `openrouter`; `batch: true`
  needs an `anthropic` provider; the model has a price unless the provider is
  `openrouter`; `system_file` and `result.schema` resolve under the config directory
  and exist; an `agent` task's `model`, when set, has a price.
- `checkAgentTools`: every `mcp_servers` entry names a process `stdio` connector and
  only ops its manifest lists.
- `checkConnectorActions`: every `connector` action and sequence step names a process
  `stdio` connector and, when its manifest has `ops`, an op in them. `oa validate` skips
  it and `checkAgentTools` when a manifest failed to load, which is reported under its
  own file. The core's
  `core.unknown_connector` warning in `activate()` remains for a core built without
  agent settings, where no cross-check runs.
- `checkSandboxes`: no `defaults.sandbox` bind, sandboxed `shell` `cwd` or bind, acp
  manifest bind, or `work_dir` exposes a protected path (the database, the socket, the
  `<socket>.net` proxy directory, `agent.yaml`, a `file` backend's secrets file); a
  sandboxed acp manifest's `cwd` is visible inside the sandbox; every `git-worktree`
  `repo` of an `agent` task on a sandboxed connector is inside that sandbox's binds.
  Paths are compared with symlinks resolved on both sides.

**`check.ts`**: `pricing` is resolved and reported at `pricing.<model>`; the summary
lines name the tasks files and manifests an `agent.yaml` pulls in.

**Warnings** (`config/lint.ts`, `lintTasks`): valid but almost certainly wrong, never
failing a file or a load. `oa validate` carries them in `FileCheck.warnings` of every
parsed tasks file and prints them with `formatWarnings` as
`<file>: <path>: warning: task "<name>": <message>` without changing the exit code; the
core runs the same lint in `activate()` (`core.ts`), so at start and on every reload,
and logs each as `core.config_warning` (`task`, `file`, `path`, `warning`).

What is linted, both for suspect comparisons and for roots the position does not
provide: every trigger `filter`, `emit` `when`, sequence step `when` and post gate
`when`; the expression inside every `${…}` template of `action`, `emit` and
`state_updates` (the strings the schema checks as templates, found with
`forEachTemplate`, path down to the string); and each `wait` `for.filter` as a whole,
with every template replaced by an identifier placeholder (`lintWaitFilter`). The wait
runner renders each template as a value in place (`expr/filter-template.ts`), so a
placeholder is never itself suspect. A filter that does not parse even with
placeholders is reported, since the dispatcher could not compile it (`wait.invalid`) and
the wait would never match. `taskActions` (`config/walk.ts`) is the one walker over a
task's action and its sequence steps; the lint, `checkSandboxes`,
`checkConnectorActions` and the core's connector-reference warning use it.

Event cycles (`eventCycles`): edges go from a task to every other task whose event
trigger's `type` or `type_any` matches a type it produces (its `emit` types and its
three lifecycle events); filters are ignored, since only the author can tell whether
one ends the cycle. Each strongly connected group is reported once, at
`tasks[<i>].trigger` of its first task in config order, with the shortest cycle through
that task; other cycles of the group are not named. Cycles span files, so
`lintTasks(tasks, all)` takes the whole config: `oa validate agent.yaml` and the core's
`activate()` pass every loaded task, while `oa validate tasks.yaml` sees one file.

Roots (`lintRoots`): each linted expression's roots (`expressionRoots` in
`expr/template.ts`: the identifiers read from the scope itself, not those after a `.`, a
`|`, a projection, a filter's condition or inside `&expr`) are compared with what its
position provides, and one outside it is reported, since it reads as null at run time.
A trigger filter and the bare part of a `wait` filter see the event's fields; an
action's templates `{event, state, secrets, env, run}`, plus `steps` in a sequence's
steps (their `when` too) and `result` in an `agent`'s `post` gates; `emit` and
`state_updates` `{event, result, state, env, run}`, plus `item` in `dedup_key` and
`payload` of a rule with `each`. In an action only the fields its runner renders are
checked (`RENDERED`: an `llm`'s `output_schema` is sent as written). `expressionRoots`
skips `&expr`, which reads each element; `collectRefs` still collects `secrets` there,
since `map(&secrets.x, [@])` reads the scope. A leading `@.` is dropped (`@.event.id` has the root `event`); any other
`@`, and the implicit scope of a top-level `*`, `[*]` or `[0]`, outside `&expr` and filters lands in `wholeScope`, which `wait` refuses. These are the scopes the executor, `sequence.ts` and
`agent.ts` build (`withScope`); a new scope key or position changes the tables at the
top of `lint.ts`. The hint names the nearest known name (exact, or within an edit distance
of a third of the root's length, at most 2) and where that name exists: `steps` in `emit`
points at `result.steps[0]`, `event` in a filter at `payload`, `payload` in a template
at `event.payload`. Fields named like a literal (`true`, `"1"`) are left to
`lintJmespath`.

`lintJmespath` (`expr/jmespath.ts`) walks the jmespath.js AST (every node that holds a
sub-expression, `KeyValuePair.value` included) for a comparison with a bare
`true`/`false`/`null` (a `Field`, which reads as null), a double-quoted `"true"`/
`"false"`/`"null"`/number (a `Field` too; the message offers the string), and an ordering
comparison with a quoted number (the spec orders numbers only; jmespath.js 0.16 coerces,
so it works by accident until the field is a string). Equality with a quoted number is
not flagged: it is right for a string field. Operands are echoed as written: the lexer's
tokens are lined up with the AST so each field and literal keeps its source text.

`parseJmespath` caches each expression's parse (AST or message), so the schema's
`validateJmespath`, the template compiler, `compileFilter` and the lint parse it once.
Its message appends a backtick hint to the parser's `Invalid token (Number)` error,
quoting the number from the source (the lexer keeps only the integer part of `100.5`).

What validation cannot see: a secret's existence (resolved at run time; a missing one
fails the run non-retryably), a connector's own `config` schema (the connector validates
it at start and exits 1), whether a `transport: acp` connector really speaks ACP.

## Reload

`daemon.reload()` (`daemon.ts`), on SIGHUP or `POST /v1/reload`, re-reads `agent.yaml`,
the manifests and the tasks files and applies them together or not at all:

1. `agent.yaml` invalid: `ok: false`, that file listed, nothing changes
   (`daemon.reload_invalid`, one error line per issue with `file`, `path`, `issue`, so a
   SIGHUP reload explains itself in the journal: `logConfigIssues` in `core.ts`).
2. `db`, `socket` or `secrets` changed (`FIXED_KEYS`): reported in `restart_required`
   and logged `daemon.reload_needs_restart`; the running values stay.
3. Manifests invalid: `ok: false` with every file listed, nothing changes
   (`daemon.reload_invalid`, per issue).
4. `core.reload()` loads and cross-checks the tasks files; invalid → `core.config_invalid`
   per issue and nothing changes; valid → every component is reconfigured and the tasks activated
   (`core.config_reloaded`), then the log level is re-applied (`--log-level` keeps
   winning over the file) and `daemon.reloaded` logged.

A run in flight finishes under the task definition it started with, also across waits,
retries and restarts (`runs.config`); the executor's defaults (`timeout`, `retry`,
`sandbox`) apply whenever it next starts or resumes. Reloads are serialised.
The report (`ReloadReport`) is what `POST /v1/reload` returns, always with status 200.

The `configure()` seams, and what each one takes:

| Component | Seam | Settings |
|---|---|---|
| `LlmService` (`llm/service.ts`) | `configure` | `providers`, `pricing`, `defaults.llm`, `defaults.decide`, `defaults.agent.budget`, `budgets.daily_usd` |
| `BatchPoller` (`llm/batches.ts`) | `configure` | `batches.poll` (rearms the timer) |
| `Executor` (`executor/executor.ts`) | `configure` | `workers`, `defaults.timeout`, `defaults.retry`, `defaults.sandbox`, `shutdown.grace` |
| `Dispatcher` (`bus/dispatcher.ts`) | `configure` | `limits.max_event_depth`, `limits.max_runs_per_chain` |
| `ConnectorSupervisor` (`connectors/supervisor.ts`) | `configure`, `apply` | `defaults.agent` (`work_dir` changed restarts every sandboxed acp connector); `apply` adds, removes and respawns connectors by manifest key, and logs `connector.unit_restart_needed` for a changed `managed_by: systemd` manifest without ops |
| pollers (`core.ts`) | swapped | every `builtin: poller` manifest is rebuilt |
| `Retention` (`retention.ts`) | `configure` | the five durations and `work_dir`; the timer is rearmed only when the interval changed |
| scheduler (`scheduler/cron.ts`) | rearmed | every cron task from scratch |
| logger | `setLevel` | `log.level` |

Invariant: a setting from `agent.yaml` is read through one of these seams, never copied
into a constructor and forgotten. Adding a key means adding it to a seam and to the
reload test in `core.test.ts`; a key that genuinely cannot change at run time joins
`FIXED_KEYS` and is documented as restart-only.

## Where the schemas feed other things

The same zod objects validate configuration and build the structured-output format of
an `llm` action (`output_schema` is handed to the adapters as JSON Schema), the
`result.schema` of an `agent` action is read as JSON Schema into zod with
`fromJSONSchema` (`actions/agent-result.ts`), and the manifest schema's effective
`transport` and `emits` are filled in by `parseManifest` so the rest of the core never
sees an unset transport.
