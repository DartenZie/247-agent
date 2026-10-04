# Command-line reference

Every command of `oa`, the daemon `247-agent-core` and the connector host
`247-agent-connector-host`, with their flags, output and exit codes.

## `oa`

`oa` talks to the daemon over its Unix socket. The socket is `--socket <path>` when given,
else `$OA_CORE_SOCKET`, else `/run/247-agent/core.sock`. Every request times out after
10 seconds.

`--socket` and `--json` belong to a command and come after it: `oa run hello --json`
works, `oa --json run hello` is an unknown command.

### Exit codes

| Code | When |
|---|---|
| 0 | the command did what it was asked |
| 1 | the daemon or the run reported a failure: the socket is unreachable, the daemon answered an error other than 400, `run --wait` ended in any status but `succeeded`, `runs show` of a `failed` run, `reload` was refused, `connector restart` left the connector not `up`, `validate` found a problem |
| 2 | usage: an unknown command or flag, a missing argument, an unreadable or invalid JSON file, no arguments at all, or the daemon answered 400 (a bad event type, pattern or `--since`) |

An unreachable socket prints `cannot connect to the daemon at <path> (<code>). Is
247-agent-core running? Set --socket or OA_CORE_SOCKET.`

### `oa validate <file>...`

Validates tasks files, connector manifests and `agent.yaml` files against the schema and
the semantic checks. An `agent.yaml` is followed to every tasks file and manifest it
names. The daemon does not need to run. There are no flags: every argument is a file.

Output, one line per file or referenced file:

```
ok <file> (<n> tasks)
ok <file> (connector <name>)
ok <file> (tasks <path>; connectors <path>)
<file>: <path>: <message>          # a problem, on stderr
```

Exit 1 when any file has a problem, 2 with no arguments.

### `oa run <task> [options]`

Queues a run of `<task>`, whatever its trigger kind. Trigger filters and cron overlap do
not apply; the task's `concurrency` and the global `workers` cap still do.

| Flag | Meaning | Default |
|---|---|---|
| `--event <file\|->` | a JSON object `{"type": "...", "payload": ...}` the action sees as its trigger event; `-` reads stdin; other keys are refused | none |
| `--type <event.type>` | sets or overrides the event type | `manual.input` |
| `--correlation <id>` | the correlation id to thread the run under | a new one |
| `--wait` | block until the run finishes | off |
| `--json` | print the response as JSON | off |
| `--socket <path>` | the daemon socket | see above |

Output:

```
queued <run id> for <task> (event <event id>)      # without --wait
succeeded <run id> for <task>                       # with --wait, then the result as JSON on the next line
<status> <run id> for <task>: <error>               # with --wait, any other final status
```

`--json` prints `{"event_id": "...", "run": {...}}`, the final run record when waiting.
Exit 1 with `--wait` when the final status is not `succeeded`; an unknown task is a
daemon error, exit 1.

### `oa emit <type> [payload.json|-] [options]`

Injects an event as if a connector had emitted it. Every task whose trigger matches
runs. Without a payload file the payload is `null`.

| Flag | Meaning | Default |
|---|---|---|
| `--source <name>` | the event's source | `manual` |
| `--dedup-key <key>` | drop the event when one with this key was already published | none |
| `--parent <event_id>` | parent event; the new one inherits its correlation id and depth + 1 | none |
| `--correlation <id>` | correlation id (ignored when `--parent` has one) | a new one |
| `--json` | print the response as JSON | off |
| `--socket <path>` | the daemon socket | see above |

Output:

```
inserted <event id> type=<type> correlation=<correlation id>
duplicate dedup_key=<key>
```

Both exit 0. An invalid type (wildcards, bad characters, more than 8 segments) or an
unknown parent is a 400 from the daemon, exit 2.

### `oa runs ls|show <id>|logs <id> [options]`

| Flag | Applies to | Meaning | Default |
|---|---|---|---|
| `--status <s>` | `ls` | `queued`, `running`, `waiting`, `succeeded`, `failed` or `cancelled` | all |
| `--task <name>` | `ls` | one task | all |
| `-n, --limit <n>` | `ls` | how many | 20 |
| `-f, --follow` | `logs` | keep printing while the run is queued, running or waiting | off |
| `--after <id>` | `logs` | transcript entries after this entry id | 0 |
| `--json` | all | JSON output (`logs`: one entry per line) | off |
| `--socket <path>` | all | the daemon socket | see above |

`ls` prints the newest runs, one per line: id, task, status, created time, duration
(`-` while unfinished, `12.3s`, `2m05s`) and the first line of the error when there is
one. `no runs` when nothing matches. Exit 0.

`show` prints one run as `key  value` rows: `run`, `task`, `status` (with `(attempt N)`
after a retry), `event` (the trigger event line, or its bare id when retention removed
it), `payload`, `created`, `started`, `finished` with `(took …)`, `cost` as
`$<usd> in <n> calls` followed by one row per ledger entry, `transcript` with the
`oa runs logs` command when an agent run recorded one, `error`, and `result` as JSON.
Exit 1 when the run's status is `failed`, else 0. `--json` prints
`{"run", "event", "ledger", "has_transcript"}`.

`logs` prints the agent transcript: a header `<time>  turn <n>  <kind>` per entry, the
prompt and the agent's text indented, tool calls with their kind, title, command and
paths, each permission decision as `allowed` or `refused` with the reason, usage,
how the turn stopped and the result. For a run of another action kind it prints
`no transcript for <run id> (<task>, <status>): only agent runs record one`. Always exit 0.

### `oa events tail|show <id> [options]`

| Flag | Applies to | Meaning | Default |
|---|---|---|---|
| `--type <type\|pattern>` | `tail` | only this type; `*` matches exactly one segment (`email.*`, `task.*.failed`) | all |
| `-n, --limit <n>` | `tail` | how many to start with | 20 |
| `-f, --follow` | `tail` | poll for new events every second until interrupted | off |
| `--json` | both | JSON output (`tail`: one event per line) | off |
| `--socket <path>` | both | the daemon socket | see above |

`tail` prints the newest events in order, one per line:

```
<time>  <event id>  <type>  source=<source>  correlation=<correlation id>  parent=<parent id>
```

`no events` when nothing matches. `show` prints that line and then `payload: <JSON>`. An
invalid pattern is a 400, exit 2; an unknown event id is exit 1; otherwise exit 0.

### `oa connector list|restart <name> [options]`

`list` prints every connector, tab-separated:

```
<name>  <state>  <transport>[ sandbox=bwrap][ net=allowlist|none][ unit=247-agent-connector@<name>]  pid=<pid>  restarts=<n>[  health=ok|failing(<n>)|unchecked][ error="..."]
<name>  up  builtin  pid=-  restarts=0                                                     # a built-in poller
```

States are `starting`, `up`, `down`, `stopped` and `external` (a connector in its own
unit that serves no ops). `health=` appears only for a manifest with `health:`.

`restart` kills one connector, resolves its secrets again and respawns it. Output
`<name>  <state>  pid=<pid>`; exit 0 only when the connector is `up` afterwards. A
built-in poller, or a unit's connector without ops, is refused with the command to use
instead (exit 1). Flags: `--json`, `--socket`.

### `oa cost [options]`

Sums the model-call ledger.

| Flag | Meaning | Default |
|---|---|---|
| `--by <task\|model\|provider\|day>` | how to group | `task` |
| `--since <duration\|timestamp>` | the window start: `7d`, `24h`, `30m`, or any timestamp `Date` parses | `24h` |
| `--json` | the response as JSON | off |
| `--socket <path>` | the daemon socket | see above |

Output: a header `task  calls  in_tok  out_tok  cache_rd  usd`, one row per group, then
`total since <timestamp>: $<usd>`; or `no model calls since <timestamp>`. A bad `--since`
is a 400, exit 2; otherwise exit 0.

### `oa reload [options]`

Asks the daemon to re-read `agent.yaml`, the connector manifests and the tasks files and
apply them together, like `systemctl reload 247-agent`. Output: `ok <file>` per file, or
the issues on stderr followed by `reload refused: the previous config stays active`
(exit 1). On success `reloaded: <n> tasks`, with `; connectors: added …; removed …;
respawned …` when connectors changed, and `restart required for: db, socket, secrets`
on stderr when one of those three changed (still exit 0). Flags: `--json`, `--socket`.

### `oa metrics [options]`

Prints `GET /metrics`, the Prometheus text exposition, to stdout. Only `--socket`. Exit 0.

### `oa help [command]`, `oa version`

`help` prints the top-level usage or one command's usage to stdout and exits 0 (`oa`
with no arguments prints the usage and exits 2). `version`, `--version` and `-V` print
the version.

## `247-agent-core`

```
247-agent-core [--config <agent.yaml>] [--log-level <level>]
```

| Flag | Meaning | Default |
|---|---|---|
| `-c, --config <file>` | the daemon configuration | `/etc/247-agent/agent.yaml` |
| `--log-level <l>` | `debug`, `info`, `warn` or `error`; overrides `log.level` from the file, also across reloads | `log.level`, else `info` |
| `-h, --help`, `-V, --version` | usage, version | |

Any other flag or a positional argument exits 2. An invalid configuration prints
`247-agent-core: invalid agent config <file>:` with the issues and exits 1.

Logs are JSON lines on stdout. The first lines of a start are `core.config_loaded`,
`core.started`, the connectors' spawn lines, `api.listening`, `daemon.started` and
`daemon.home` (the version and the install root). Relative paths in `agent.yaml` resolve
against its directory.

If the socket file exists, the daemon probes it: a live daemon makes the start fail with
`another daemon is listening on <path>` (exit 1); a stale file from a dead daemon is
removed with a `api.stale_socket_removed` warning. The socket is created with mode `0660`.

| Signal | Effect |
|---|---|
| `SIGHUP` | reload: the same as `oa reload`, outcome in the log (`daemon.reloaded`, `daemon.reload_invalid`, `daemon.reload_needs_restart`) |
| `SIGTERM`, `SIGINT` | stop: runs in flight are aborted and recovered on the next start; exit 0 |

The daemon sets `OA_HOME` to its install root and puts `<root>/bin` and its own Node
first on `PATH` for everything it spawns. Exit codes: 0 after a clean stop, 1 on a
start-up failure or a crash, 2 on a usage error.

## `247-agent-connector-host`

```
247-agent-connector-host [--config <agent.yaml>] [--socket <path>] <connector>
```

Runs one connector whose manifest says `managed_by: systemd`, as the
`247-agent-connector@<connector>` unit does. `--config` defaults to
`/etc/247-agent/agent.yaml`; `--socket` is where a connector with ops listens (default:
the manifest's `socket`, else `/run/247-agent-connector/<connector>/mcp.sock`). It logs
JSON lines on stderr, every line carrying `connector`.

It refuses to start (exit 1) when `agent.yaml` or a manifest is invalid, the connector
does not exist, its manifest is not `managed_by: systemd`, it has no `exec`, or a secret
it needs cannot be resolved. Other start failures exit 70; usage errors exit 2. A
`transport: none` connector that exits by itself ends the host with the child's code (a
child exit of 0 becomes 1, so `Restart=always` restarts it); a connector with ops is
started afresh for every connection from the daemon, reading its config and secrets
again. See [A connector in its own unit](../connectors/own-unit.md).

## Environment variables

| Variable | Who reads it | Meaning |
|---|---|---|
| `OA_CORE_SOCKET` | `oa`; connectors | the daemon socket when `--socket` is absent; set for every connector child (not for agent programs) |
| `OA_HOME` | the daemon, the host, the launchers | the install root; exported by every `bin/` launcher, else found by walking up from the running script to a directory with `bin/247-agent-core` |
| `OA_SECRET_<NAME>` | the `env` secrets backend | a secret's value, by upper-cased name; the prefix is configurable; removed from the `${env…}` template scope |
| `CREDENTIALS_DIRECTORY` | the `systemd-credentials` backend | where `LoadCredential=` files are, one per secret |
| `OA_CONNECTOR_NAME` | connectors, agent programs | the manifest's `name` |
| `OA_CONFIG_JSON` | connectors | the manifest's `config` as JSON with secrets rendered; the SDK deletes it after reading |

A connector child otherwise inherits only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and
`USER` from the daemon, plus its manifest's `env`.
