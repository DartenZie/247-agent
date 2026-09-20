---
name: 247-agent-operate
description: "Run, inspect and debug a 247-agent daemon and its workflows, locally or on a server. Use it whenever the user wants to start the daemon, validate config, trigger a task by hand (`oa run`), inject an event (`oa emit`), see why a run failed or a task never ran, list runs or events, read or change state (`/v1/state`), tail the JSON logs, test a workflow end to end with fake connectors, reload config (SIGHUP), or asks anything like \"is it running\", \"what happened to X\", \"replay this email\", \"the cron never fires\", \"cannot connect to the socket\". Also use it before and after editing tasks or connectors to prove the change works on a real daemon."
---

# Operate a 247-agent daemon

Everything the daemon knows is in SQLite and reachable over one Unix socket: events,
runs (status, input event, result, error, attempts), state, health. Debugging is
therefore always the same loop: reproduce with `oa run`/`oa emit`, read the run, read
the log lines that share its `run_id`, fix, validate, repeat.

## Binaries and paths

| what | in this repo (after `npm run build`) | production |
|---|---|---|
| daemon | `node packages/core/dist/main.js --config <agent.yaml>` (or `npm start -- --config …`) | systemd unit `247-agent`, config `/etc/247-agent/agent.yaml` |
| `oa` | `node packages/cli/dist/main.js` (or `npm run oa -- …`) | `oa` |
| socket | the `socket:` in `agent.yaml`, relative to that file | `/run/247-agent/core.sock` |

`oa` finds the socket from `--socket`, else `$OA_CORE_SOCKET`, else the production
path. Export `OA_CORE_SOCKET` once per shell. Exit codes: 0 ok, 1 daemon or run
failure, 2 usage.

## Commands

```
oa validate <file>...                          # tasks files, manifests, agent.yaml (follows references)
oa run <task> [--event f.json] [--type t] [--correlation id] [--wait] [--json]
oa emit <type> [payload.json|-] [--source s] [--dedup-key k] [--parent evt] [--correlation id] [--json]
oa connector list [--json]                     # state, pid, restarts per connector
oa connector restart <name> [--json]           # kill, re-resolve secrets, respawn; exit 1 if not up after
```

`oa run` bypasses filters and cron overlap and gives the action `--event` as its
trigger event, so it tests the action and `emit`. `oa emit` goes through the trigger
and filter, so it tests the routing too. `--wait` prints the result and exits 1 on
failure.

The API has more than the CLI exposes; use `scripts/oa-api.mjs` (Node, no
dependencies) or `curl --unix-socket`. Endpoints in `references/api.md`.

```
node skills/247-agent-operate/scripts/oa-api.mjs health
node skills/247-agent-operate/scripts/oa-api.mjs runs --status failed --limit 10
node skills/247-agent-operate/scripts/oa-api.mjs run <run_id>
node skills/247-agent-operate/scripts/oa-api.mjs event <event_id>
node skills/247-agent-operate/scripts/oa-api.mjs state email [last_uid]
node skills/247-agent-operate/scripts/oa-api.mjs state email last_uid --set '42'
node skills/247-agent-operate/scripts/oa-api.mjs GET '/v1/runs?task=fetch_email&limit=5'
```

## Local run in five steps

1. Build: `npm install && npm run build`.
2. Config in a scratch dir with short paths (macOS caps socket paths at 104 bytes):
   `docs/examples/hello-world/agent.yaml` is a ready-made one under `/tmp/247-agent`.
3. `oa validate <agent.yaml>`.
4. Start in the foreground: `node packages/core/dist/main.js --config <agent.yaml>`.
   Logs are JSON lines on stdout; add `--log-level debug` when hunting.
5. In another shell: `export OA_CORE_SOCKET=<socket>`; `oa run <task> --wait`.

To exercise a whole workflow without a model or the network, replace the connectors
with the fakes in `packages/core/test/fixtures/` (inline manifests with
`exec: [node, …/fake-email.ts]`) and the `llm`/`agent` tasks with `shell` stand-ins
that emit the same events. `packages/core/src/integration.test.ts` is a complete
example of both and is the pattern for a new integration test.

## Reading a failure

1. `oa-api.mjs runs --status failed` → pick the run, note `run_id`, `task`, `error`,
   `attempt`, `event_id`.
2. `oa-api.mjs run <run_id>` → the input event and the result/error in full.
3. Log lines: `grep '<run_id>'` on the daemon output, or on a server
   `journalctl -u 247-agent -o cat | grep <run_id>`. Every line about a run carries
   `run_id`, `task`, `correlation_id`; `correlation_id` links every task the same
   real-world event triggered.
4. Reproduce: save the input event's `{type, payload}` to a file and
   `oa run <task> --event f.json --wait`.

`references/troubleshooting.md` maps the common errors to their causes.

## Signals and lifecycle

| Signal | Effect |
|---|---|
| `SIGHUP` (`systemctl reload 247-agent`) | Re-reads tasks files; running runs finish under the old config; an invalid file keeps the previous config. Connector manifest changes need a restart. |
| `oa connector restart <name>` | Respawns one connector with freshly resolved secrets; the daemon and the other connectors keep running. Refused (409) for a built-in poller. |
| `SIGTERM`/`SIGINT` | Stops the daemon; runs in flight are aborted. |

On the next start a `running` run is re-queued if `retry.attempts` allows, else failed
as interrupted; `waiting` runs stay waiting and resume when their event arrives. A
stale socket file from a dead daemon is replaced; a live one refuses the start.

## After a change

Run this before saying a config change is done:

```
oa validate <changed files> docs/examples/*.yaml docs/examples/connectors.d/*.yaml
```

For code changes: `npm run build && npm test && npm run lint`.

Source of truth: `docs/USER-GUIDE.md` §3, §7–§9, §11; `docs/ARCHITECTURE.md` §4, §10, §12.
