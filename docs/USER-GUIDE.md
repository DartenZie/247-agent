# 247-agent — User Guide

How to install, configure and operate the daemon. For the design and the reasoning behind
it, read [`ARCHITECTURE.md`](ARCHITECTURE.md); this guide only tells you what to write in
the config files and what to type at the shell.

Status of the code today: everything that does not call a model works end to end
(`shell`, `connector`, `wait`, `sequence`, cron/event/manual triggers, routing, state,
secrets, retries, connectors, the CLI). `llm` and `agent` actions validate but have no
runner yet, so a run of one fails with "no runner". Budgets, retention and the cost
ledger are accepted in config but not applied. Section 10 lists the gaps.

## 1. What it does

You describe **tasks** in YAML. Each task has a **trigger** (a cron schedule, an event
type, or nothing but `oa run`), one **action**, and optional **routing** of the result
into new events. The daemon runs around the clock, persists every event and run in
SQLite, and calls a model only inside an `llm` or `agent` action.

```
connector ──event──▶ trigger ──▶ task ──result──▶ more events ──▶ more tasks
```

Tasks never call each other. A task that should run "after `fetch_email`" triggers on
an event `fetch_email` emits, or on the automatic `task.fetch_email.succeeded` event.
That is what lets you add or remove tasks without editing the others.

## 2. Install and build

Requirements: Node.js 22 or newer, npm, git. Linux is the target; macOS works for
development.

```
git clone <repo> 247-agent && cd 247-agent
npm install
npm run build
npm test            # optional, no network needed
```

This produces two entry points:

| Program | Path after build | Purpose |
|---|---|---|
| daemon | `packages/core/dist/main.js` | `247-agent-core`, the always-on process |
| CLI | `packages/cli/dist/main.js` | `oa`: validate config, run tasks by hand, inject events |

For convenience in a shell:

```
alias 247-agent-core='node /opt/247-agent/packages/core/dist/main.js'
alias oa='node /opt/247-agent/packages/cli/dist/main.js'
```

## 3. Five-minute start

1. Create a config directory (anywhere; `/etc/247-agent` in production).

   ```
   mkdir -p ~/oa && cd ~/oa
   ```

2. Write `agent.yaml`. Paths are relative to this file.

   ```yaml
   db: state.db
   socket: core.sock
   tasks: tasks.yaml
   secrets: { backend: env, prefix: OA_SECRET_ }
   log: { level: info }
   ```

3. Write `tasks.yaml` with one deterministic task.

   ```yaml
   tasks:
     - name: disk_report
       trigger: { kind: cron, schedule: "0 8 * * *" }
       action:
         kind: shell
         cmd: ["df", "-h", "/"]
         result: text_stdout
   ```

4. Validate, then start the daemon in the foreground.

   ```
   oa validate agent.yaml
   247-agent-core --config agent.yaml
   ```

   Logs are JSON lines on stdout. Stop it with Ctrl-C.

5. In another shell, run the task by hand and watch the result.

   ```
   export OA_CORE_SOCKET=~/oa/core.sock
   oa run disk_report --wait
   ```

   You get `succeeded <run id> for disk_report` followed by the result as JSON.

## 4. Configuration

### 4.1 `agent.yaml`

The global file. Every key has a default; the full reference is
[`examples/agent.yaml`](examples/agent.yaml).

| Key | Meaning | Default |
|---|---|---|
| `db` | SQLite file (events, runs, state) | `/var/lib/247-agent/state.db` |
| `socket` | Unix socket for the API and the CLI | `/run/247-agent/core.sock` |
| `tasks` | A tasks file, a directory of `*.yaml`, or a list of both. Merged; task names must be unique across files | `tasks.yaml` |
| `connectors` | Manifest file(s), directories, or inline manifests | none |
| `workers` | Runs executing at the same time, globally | 4 |
| `log.level` | `debug`, `info`, `warn`, `error` | `info` |
| `limits.max_event_depth` | Events deeper than this in a causal chain are dropped (loop guard) | 32 |
| `defaults.timeout` | Per-attempt wall-clock limit for tasks without their own | `15m` |
| `defaults.retry` | Retry policy for tasks without their own (see 4.4) | 1 attempt |
| `defaults.sandbox` | `none` or `bwrap` for `shell` actions without their own (see 5.1) | `none` |
| `secrets` | Where secret values come from (see 4.6) | `{ backend: env }` |
| `defaults.llm`, `defaults.agent`, `budgets`, `retention` | Accepted, not applied yet | |

Relative `db`, `socket`, `tasks` and `connectors` paths resolve against the directory of
`agent.yaml`. On macOS keep the socket path short: Unix socket paths are limited to 104
bytes.

### 4.2 Tasks

A tasks file is `tasks: [...]`. Each task:

```yaml
- name: fetch_email                 # [a-z][a-z0-9_]*, unique
  trigger: { ... }                  # 4.3
  action: { ... }                   # 5
  concurrency: 1                    # runs of this task at once (default 1)
  timeout: 15m                      # per attempt of active work
  retry: { attempts: 3, backoff: exponential, base: 30s, max: 1h }
  state_updates: { email.last_uid: "${result.last_uid}" }   # after success
  emit: [ ... ]                     # 4.5
```

### 4.3 Triggers

**cron** — one run per tick. A tick is skipped while a run of the task is queued,
running or waiting, unless `overlap: allow`. Ticks missed while the daemon was down are
not replayed.

```yaml
trigger: { kind: cron, schedule: "*/2 * * * *", tz: Europe/Prague, overlap: skip }
```

**event** — one run per matching event. Exactly one of `type` or `type_any`. A `*`
matches exactly one dot-separated segment (`task.*.failed`). `filter` is a JMESPath
expression evaluated against the whole event; a falsy result means no run. Put every
cheap relevance check here (sender, label, repo), not in a model prompt.

```yaml
trigger:
  kind: event
  type: email.received
  filter: "payload.from == 'orchestrator@example.cz'"
```

```yaml
trigger:
  kind: event
  type_any: [task.publish_site.succeeded, "task.*.failed", budget.exceeded]
```

**manual** — no automatic trigger. Any task, whatever its trigger, can be started with
`oa run`, which bypasses filters and cron overlap.

```yaml
trigger: { kind: manual }
```

A task never triggers on its own `task.<name>.succeeded|failed` events, and never on
events whose source is its own runs, so a `notify` task on `task.*.failed` cannot loop
on its own failure.

### 4.4 Timeouts, retries, concurrency

- `timeout` bounds each attempt of active work. Time spent `waiting` (see 5.5) does not
  count.
- `retry` makes attempts of the same run with backoff (`fixed` or `exponential` from
  `base`, capped at `max`). The run stays `running` between attempts; the automatic
  `task.<name>.failed` event fires once, after the last attempt. Timeouts and "connector
  is down" errors are retried. Missing secrets, unknown connectors, an op result flagged
  as an error, a wait timeout and an `emit` rule that cannot be rendered are not.
- `concurrency` is per task; `workers` in `agent.yaml` is the global cap.

### 4.5 Routing results: `emit`

Every task automatically emits `task.<name>.succeeded` (payload: the result) or
`task.<name>.failed` (payload: the error). `emit` adds domain events:

```yaml
emit:
  - type: email.received
    each: ${result.emails}              # one event per array item, available as `item`
    dedup_key: "email:${item.message_id}"
    payload: ${item}
  - type: orchestra.classified
    when: "result.kind != 'ignore'"     # JMESPath over {event, result, state, env, run}
    payload: { kind: "${result.kind}", email: "${event.payload}" }
```

- `each` must be a single `${…}` that renders to an array. `null` emits nothing.
- `dedup_key` makes delivery idempotent: a later event with the same key is dropped.
- Emitted events get `source: task:<name>`, the trigger event as parent, and inherit its
  `correlation_id`.
- `state_updates` (`<namespace>.<key>: value`) are written in the same transaction, after
  a successful run only.
- Secrets are not allowed in `emit` or `state_updates`; `oa validate` rejects them.

### 4.6 Secrets

Reference a secret by name in an action (`${secrets.ftp_pass}`) or in a connector
manifest. The daemon resolves only the names a run actually uses, at run time, from one
backend:

| `secrets:` in agent.yaml | Where the value comes from |
|---|---|
| `{ backend: env, prefix: OA_SECRET_ }` | `OA_SECRET_FTP_PASS` in the daemon's environment (name upper-cased) |
| `{ backend: file, path: secrets.yaml }` | A YAML or JSON map `name: value`, re-read on every resolve; must be mode 0600 or the resolve fails |
| `{ backend: systemd-credentials }` | One file per secret under `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`) |

Secret values never reach the database, the logs or an event payload. `secrets` may
only be used inside `action`, only as `secrets.<name>`, never as a whole.

A connector receives its secrets once, when it is spawned. After rotating a value, run
`oa connector restart <name>` so the process is respawned with the new one; the built-in
poller re-reads on every poll and needs nothing.

### 4.7 Templates and expressions

Anywhere a value is templated, `${ <JMESPath> }` is evaluated over this scope:

| Name | What it is |
|---|---|
| `event` | The event that triggered the run (`event.type`, `event.payload`, `event.correlation_id`, …) |
| `result` | The action's result. Only in `emit` and `state_updates` |
| `state` | A snapshot of the KV state at run start (`state.email.last_uid`) |
| `secrets` | Secret values. Actions only |
| `env` | The daemon's environment variables |
| `run` | `{id, task, attempt, event_id, correlation_id}` |
| `item` | The current element of an `each` fan-out |
| `steps` | Earlier step results inside a `sequence` |

Rules:

- A string that is exactly one `${…}` yields the raw value (a number stays a number, an
  object stays an object). Text around a template makes a string; non-strings are
  JSON-encoded, `null` becomes empty.
- Inside a YAML flow mapping `{ … }` quote the template:
  `{ since_uid: "${state.email.last_uid}" }`.
- Trigger `filter`, emit `when` and sequence `when` are bare JMESPath, not `${…}`
  templates. Compare with backtick literals for numbers and booleans:
  `` payload.approved == `true` ``.

`oa validate` checks the syntax of every template and expression.

## 5. Actions

One `action` per task. `kind` selects the runner.

### 5.1 `shell`

```yaml
action:
  kind: shell
  cmd: ["lftp", "-e", "mirror -R --delete dist/ /public_html; quit", "sftp://ftp.example.cz"]
  cwd: /var/lib/247-agent/repos/orchestra-site
  env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
  stdin: ${event.payload}              # optional; non-strings are sent as JSON
  result: text_stdout                  # | json_stdout | exit_code
  sandbox: none                        # | bwrap | { backend: bwrap, ro_binds: [...], rw_binds: [...], extra_args: [...] }
```

`cmd` is argv, no shell. Spell out `["bash", "-c", "…"]` when you need one. The result
is stdout as text (default), stdout parsed as JSON (invalid JSON fails the run), or the
exit code as a number (then a non-zero exit is a result, not a failure). A non-zero exit
in the other two modes fails the run with the tail of stderr in the error.

`sandbox: bwrap` runs the command in bubblewrap: its own pid namespace, the OS
(`/usr`, `/lib`, `/lib64`, `/bin`, `/etc`) read-only, a private `/tmp`, `cwd` as the only
writable path (no `cwd` means the command runs in that `/tmp`), and an environment of
just the action's `env` plus `PATH`, `HOME` and `LANG`. The daemon's socket, database
and other processes are out of reach. `ro_binds`/`rw_binds` mount more host paths at the
same location, `extra_args` passes raw bwrap flags (`--unshare-net` for an offline step).
The default comes from `defaults.sandbox` in `agent.yaml`; `sandbox: none` on an action
opts out. Needs the `bubblewrap` package (§8).

### 5.2 `connector`

Calls one operation (an MCP tool) on a running connector.

```yaml
action:
  kind: connector
  connector: email
  op: fetch_new
  args: { folder: INBOX, since_uid: "${state.email.last_uid}" }
  timeout: 60s
```

The result is the tool's structured content, or its text parsed as JSON when it is
JSON. An op that is not in the manifest's `ops` allowlist, or a tool result flagged as
an error, fails the run without retry. A connector that is down fails it with retry.

### 5.3 `wait`

Suspends the run until a matching event arrives. Use it for human approval.

```yaml
action:
  kind: wait
  for:
    type: chat.reply
    filter: "payload.correlation_id == '${event.correlation_id}'"
  timeout: 24h
  on_timeout: fail                     # | succeed → result {timed_out: true}
```

The run sits in `waiting` in SQLite, survives restarts, and resumes when the event is
published. `for.filter` is rendered as a template first (so `${event…}` refers to the
waiting run's own event), then evaluated as JMESPath over each incoming event. Events
published between the run's trigger and the wait being armed are checked too. The result
is the matched event.

### 5.4 `sequence`

A few `shell`, `connector` and `wait` steps in one run, each with an optional `when`.

```yaml
action:
  kind: sequence
  steps:
    - kind: connector
      connector: chat
      op: ask
      args: { text: "Approve ${event.payload.summary}?", correlation_id: "${event.correlation_id}" }
    - kind: wait
      for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
      timeout: 24h
    - kind: shell
      when: "steps[1].payload.approved == `true`"
      cwd: ${event.payload.worktree}
      cmd: ["git", "push", "origin", "HEAD:main"]
```

`steps[i]` in later templates and `when` expressions is the result of step i (`null`
when skipped). The run result is `{steps: [...]}`. A `wait` step checkpoints the
sequence; after a restart or a retry it continues from that step. Use a sequence for
tightly coupled steps only. Anything another workflow might want to observe or reuse
should be its own task and event.

### 5.5 `llm` and `agent` (not runnable yet)

Both kinds are accepted by `oa validate` so a complete workflow can be written now, and
[`examples/orchestra-website.yaml`](examples/orchestra-website.yaml) shows the intended
shape: `llm` is one model call with a JSON `output_schema`; `agent` is a Claude Agent
SDK loop in a fresh git worktree with `tools`, `bash_allow`, `max_turns`, a `budget`, a
`RESULT.json` contract and deterministic `post` gates. A run of either fails today with
"no runner". See ARCHITECTURE §5.2 and §5.3 for the full field list.

## 6. Connectors

A connector is a separate process the daemon spawns. It can emit events into the core,
expose operations as an MCP server on stdio, or both. One connector, the `poller`, is
built into the daemon and needs no process (§6.5).

### 6.1 Manifest

One file per connector under `connectors.d/`, or inline in the `connectors:` list of
`agent.yaml`.

```yaml
name: email                                   # [a-z][a-z0-9_-]*, unique
exec: ["node", "connectors/email/dist/main.js"]
cwd: .                                        # relative to the manifest (optional)
transport: stdio                              # stdio = MCP server; none = emits only
emits: [email.received]                       # documentation of what it publishes
ops: [fetch_new, mark_read, send]             # tools the core may call; [] = any
config:                                       # passed as OA_CONFIG_JSON, secrets rendered
  host: imap.example.cz
  user: "${secrets.imap_user}"
  password: "${secrets.imap_pass}"
env: { NODE_ENV: production }                 # extra environment
restart: { base: 1s, max: 60s }               # crash backoff, doubling
```

`config` and `env` values may use `${secrets.<name>}` and `${env.<VAR>}` only.

### 6.2 Lifecycle

The supervisor starts every connector with the daemon, restarts a crashed one with
exponential backoff (reset after 30 seconds of uptime), and gives it this environment on
top of a minimal one (`PATH`, `HOME`, …):

| Variable | Value |
|---|---|
| `OA_CORE_SOCKET` | The core's Unix socket |
| `OA_CONNECTOR_NAME` | The manifest's `name` |
| `OA_CONFIG_JSON` | The manifest's `config` as JSON, secrets rendered |

`connectorEnv()` deletes `OA_CONFIG_JSON` from the environment after reading it, so
subprocesses the connector starts do not inherit the rendered secrets. Anything the
connector writes to stderr is logged by the daemon as `connector.output`. Changing a
manifest needs a daemon restart; SIGHUP reloads tasks files only. `oa connector restart
<name>` respawns one connector with freshly resolved secrets (section 7).

### 6.3 Writing one in TypeScript

The `@247-agent/connector-sdk` package does the boilerplate. This is the shape of the
fake email connector the tests use
([`packages/core/test/fixtures/fake-email.ts`](../packages/core/test/fixtures/fake-email.ts)):

```ts
import { z } from 'zod';
import { defineTool, runConnector } from '@247-agent/connector-sdk';

await runConnector({
  setup: async (rt) => {
    // optional: start a poller or a bot here; rt.env.config is the manifest's config
  },
  tools: (rt) => [
    defineTool({
      name: 'fetch_new',
      input: { folder: z.string().optional(), since_uid: z.number().nullable().optional() },
      handler: async (args) => {
        const cursor = await rt.core.getState('last_uid');      // own namespace
        // ... fetch ...
        await rt.core.putState('last_uid', 42);
        return { emails: [], last_uid: 42 };                     // the op's result
      },
    }),
  ],
});
```

Push-style connectors (a chat bot, a webhook receiver) publish with
`rt.core.emitEvent({ type, payload, dedup_key?, correlation_id? })`. `rt.log(line)`
writes to stderr.

### 6.4 Any other language

Two HTTP calls and one protocol are all the core needs:

- Emit an event: `POST /v1/events` on the socket with
  `{"type": "...", "source": "<name>", "payload": {...}, "dedup_key": "..."}`.
- Read or write your state: `GET|PUT /v1/state/<name>/<key>` (`PUT` body `{"value": ...}`).
- Expose operations: speak MCP over stdio. Any existing MCP server works as a connector
  with `transport: stdio`.

```
curl --unix-socket /run/247-agent/core.sock -X POST http://unix/v1/events \
  -H 'content-type: application/json' \
  -d '{"type":"webhook.received","source":"webhook","payload":{"repo":"x"}}'
```

### 6.5 The built-in `poller`

Any op that lists things can become an event source without writing code: a manifest
with `builtin: poller` instead of `exec` runs inside the daemon, calls the op on a cron,
and emits one event per item it has not seen before.

```yaml
# connectors.d/github-prs.yaml
name: github_prs
builtin: poller
config:
  schedule: "*/5 * * * *"          # cron, 5 or 6 fields; tz: Europe/Prague optional
  connector: github                # a process connector that serves the op
  op: list_pull_requests
  args: { owner: acme, repo: site, state: open }   # ${secrets.<name>} and ${env.<VAR>} allowed
  items: "pull_requests"           # JMESPath over the result → the array (default: the result)
  item_key: "number"               # JMESPath over one item → its identity (string or number)
  event: github.pr_opened          # emitted once per new item, the item as payload
  first_run: emit                  # or skip: on the first poll, only remember what exists
  keep: 1000                       # how many seen keys to remember
  timeout: 30s                     # per op call (optional)
```

How it behaves:

- Events carry `source: github_prs` and `dedup_key: github_prs:<key>`, so an item can
  never fire twice even if you reset the poller.
- Seen keys are in the state KV: `GET /v1/state/github_prs/seen`. Delete that key to
  treat everything as new again (the event `dedup_key` still blocks true repeats).
- A key that drops out of the result stays seen until `keep` newer keys have pushed it out.
- A tick while the previous poll is still running is skipped. A failed poll (target
  connector down, op error, result not an array, item without a key) is logged as
  `poller.failed` with the reason and tried again at the next tick; nothing is emitted
  and the seen list is untouched.
- `oa validate` checks that `connector` names a process connector that lists `op` in its
  `ops` (or has `ops: []`). `emits` may be omitted; it defaults to `[event]`.

Use the poller when the op returns "what exists now" (open PRs, unread messages, files in
a folder). When the op takes a cursor and returns only what is new, a cron task with
`state_updates` and `emit … each` (§4.5) is the better fit.

## 7. The `oa` command

`oa` talks to the daemon over the socket: `--socket <path>`, else `$OA_CORE_SOCKET`, else
`/run/247-agent/core.sock`. Exit codes: 0 ok, 1 the daemon or the run reported a
failure, 2 usage.

```
oa validate <file>...
```

Validates tasks files, connector manifests and `agent.yaml` files. An `agent.yaml` is
followed to every tasks file and manifest it names, and task and connector names are
checked for uniqueness across files. Run it in CI on the whole config tree. The daemon
does not need to be running.

```
oa run <task> [--event f.json] [--type <event.type>] [--correlation <id>] [--wait] [--json]
```

Queues a run of `<task>` whatever its trigger kind. Filters and cron overlap do not
apply. `--event` supplies the event the action sees, as `{"type": "...", "payload": ...}`
(default type `manual.input`), so you can replay a real email through a task. `--wait`
blocks until the run finishes, prints the result and exits 1 on failure.

```
oa emit <type> [payload.json|-] [--source <name>] [--dedup-key <key>] [--parent <event_id>] [--correlation <id>] [--json]
```

Injects an event as if a connector had emitted it. `-` reads the payload from stdin.
Every task whose trigger matches runs. The output tells you whether the event was
inserted or dropped as a duplicate of its `dedup_key`.

```
oa connector list [--json]
oa connector restart <name> [--json]
```

`list` shows every connector with its state, pid and restart count; built-in pollers
appear with `builtin`. `restart` kills one supervised connector, resolves its secrets
again and respawns it, so it is the step after rotating a secret. It exits 1 when the
connector is not up afterwards. A built-in poller is refused, since it re-reads its
secrets on every poll.

```
oa help [command]
```

`oa events`, `oa runs` and `oa cost` from the architecture document do not exist yet;
use the API (section 8) for the same information.

## 8. The API

HTTP over the Unix socket, JSON in and out. This is what `oa` and connectors use, and
what you use for anything the CLI does not cover yet.

| Method and path | Purpose |
|---|---|
| `GET /v1/health` | `{ok, pid, started_at, uptime_s, config_file, tasks, runs: {…}}` |
| `POST /v1/events` | Publish an event. 201 inserted, 200 duplicate |
| `GET /v1/events/{id}` | One event |
| `POST /v1/runs` | Start a task by hand: `{"task": "...", "type"?: "...", "payload"?: ..., "correlation_id"?: "..."}` |
| `GET /v1/runs?status=&task=&limit=` | Runs, newest first |
| `GET /v1/runs/{id}` | One run: status, input event, result, error, attempts |
| `GET /v1/state/{ns}` | All keys in a namespace |
| `GET`, `PUT`, `DELETE /v1/state/{ns}/{key}` | One state value (`PUT` body `{"value": ...}`) |
| `GET /v1/connectors` | `{connectors: [{name, state, pid, restarts, error, builtin}]}` |
| `POST /v1/connectors/{name}/restart` | Kill, re-resolve secrets, respawn; returns the new status. 409 for a built-in |

Errors are `{error, issues?}` with status 400, 404, 405, 409 or 413.

```
curl --unix-socket $OA_CORE_SOCKET 'http://unix/v1/runs?status=failed&limit=10'
curl --unix-socket $OA_CORE_SOCKET http://unix/v1/state/email
```

Run statuses: `queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`.

## 9. Running in production

### 9.1 Layout

```
/etc/247-agent/
  agent.yaml
  tasks.d/*.yaml
  connectors.d/*.yaml
  prompts/*.md          # for llm/agent tasks, once they run
  schemas/*.json
/var/lib/247-agent/
  state.db
  repos/                # base checkouts for agent worktrees
  work/<run_id>/
/run/247-agent/core.sock
```

Keep `/etc/247-agent` in git and run `oa validate` on it before every deploy.

### 9.2 systemd unit

```ini
# /etc/systemd/system/247-agent.service
[Unit]
Description=247-agent core
After=network-online.target

[Service]
User=247-agent
ExecStart=/usr/bin/node /opt/247-agent/packages/core/dist/main.js --config /etc/247-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
LoadCredential=imap_pass:/etc/credstore/imap_pass
LoadCredential=ftp_pass:/etc/credstore/ftp_pass
RuntimeDirectory=247-agent
StateDirectory=247-agent
ProtectSystem=strict
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

With `secrets: { backend: systemd-credentials }` each `LoadCredential=` name becomes a
secret of the same name. Logs are JSON lines on stdout, so `journalctl -u 247-agent
-o cat | jq` works. Every line about a run carries `run_id`, `task` and
`correlation_id`.

### 9.3 Signals and restarts

| Signal | Effect |
|---|---|
| `SIGHUP` | Re-reads the tasks files. Running runs finish under the old config. An invalid file is logged and the previous config stays active. Connector changes need a restart |
| `oa connector restart <name>` | Not a signal, but the way to make one connector pick up a rotated secret without restarting the daemon |
| `SIGTERM`, `SIGINT` | Stops the daemon. Runs in flight are aborted |

On the next start, a run that was `running` is re-queued when its retry policy allows
another attempt, otherwise marked failed as interrupted. `waiting` runs stay waiting and
resume when their event arrives; a wait whose timeout already passed ends immediately. A
stale socket file left by a dead daemon is replaced; a live one refuses the start.

### 9.4 Daemon flags

```
247-agent-core [--config <agent.yaml>] [--log-level debug|info|warn|error]
```

`--config` defaults to `/etc/247-agent/agent.yaml`; `--log-level` overrides
`log.level` from the config.

## 10. Reference workflow and current gaps

[`examples/orchestra-website.yaml`](examples/orchestra-website.yaml) is the complete
worked example: poll a mailbox on cron, classify the conductor's emails with one Haiku
call, edit the site with a scoped agent, gate on a build, ask for approval on chat, mirror
over FTP, notify. Its non-model path runs today against fake connectors in
`packages/core/src/integration.test.ts`.

Not implemented yet, in the planned order:

1. Cost ledger and budgets (`budget.max_usd`, `budgets.daily_usd`, `budget.exceeded`).
2. The `llm` action.
3. The `agent` action.
4. Real `email` and `chat` connectors under `connectors/`.
5. Retention GC, `/metrics`, `oa cost|runs|events|connectors`, SIGHUP reload of
   connectors, `health.interval` in manifests.

Until then, every `llm` or `agent` task in a config validates but fails at run time, and
model-backed steps have to be replaced by `shell` or `connector` tasks.

## 11. Troubleshooting

- **`oa` says it cannot connect.** The daemon is not running, or the socket path differs.
  Pass `--socket` or set `OA_CORE_SOCKET` to the `socket` value from `agent.yaml`,
  resolved against that file's directory.
- **A cron task never runs.** A previous run is still queued, running or waiting and
  `overlap` is `skip`. Check `GET /v1/runs?task=<name>`.
- **An event task never runs.** Test the filter: `oa emit <type> payload.json` and look at
  the runs. A filter that throws counts as no match and is logged at the daemon.
  Remember that a task ignores events from its own runs.
- **Run failed with "secret … is not set".** The backend has no value for that name.
  With the `env` backend the variable is `<prefix><NAME>` upper-cased.
- **Run failed with "no runner".** The task is `llm` or `agent`; see section 10.
- **A `wait` resumed with the wrong event.** Tighten `for.filter`; match on
  `correlation_id` as the examples do.
- **Templates render as literal text.** Inside a YAML flow mapping the `${…}` must be
  quoted, and `filter`/`when` take bare JMESPath without `${…}`.
