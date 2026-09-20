# `agent.yaml` key reference

From `packages/core/src/config/agent.ts` and `docs/USER-GUIDE.md` §4.1. The schema is
strict; unknown keys are rejected.

| Key | Meaning | Default |
|---|---|---|
| `db` | SQLite file (events, runs, state, ledger); WAL mode | `/var/lib/247-agent/state.db` |
| `socket` | Unix socket for the API and `oa` | `/run/247-agent/core.sock` |
| `tasks` | A tasks file, a directory of `*.yaml`, or a list of both; merged | `tasks.yaml` |
| `connectors` | Manifest file(s), directories, or inline manifest objects | none |
| `workers` | Global cap on runs executing at once | `4` |
| `log.level` | `debug`, `info`, `warn`, `error` | `info` |
| `limits.max_event_depth` | Events deeper than this in a causal chain are dropped | `32` |
| `defaults.timeout` | Per-attempt wall-clock limit for tasks without `timeout` | `15m` |
| `defaults.retry` | `{attempts, backoff, base, max}` for tasks without `retry` | 1 attempt, exponential, 30s, 1h |
| `defaults.llm` | `{model, max_tokens, effort?}` | accepted, not applied yet |
| `defaults.agent` | `{model, effort, max_turns, budget}` | accepted, not applied yet |
| `secrets` | `{backend: env, prefix?}`, `{backend: file, path}`, `{backend: systemd-credentials}` | `{backend: env}` |
| `budgets.daily_usd` | Global daily cap; exceeding pauses model tasks and emits `budget.exceeded` | accepted, not applied yet |
| `retention` | `{events, runs, workspaces}` durations for GC | accepted, no GC yet |

Durations: `500ms`, `30s`, `15m`, `24h`, `7d`.

## Minimal development file

```yaml
db: state.db
socket: core.sock
tasks: tasks.yaml
secrets: { backend: env, prefix: OA_SECRET_ }
log: { level: debug }
```

Start with `node packages/core/dist/main.js --config ./agent.yaml`; on macOS keep the
directory path short (socket paths are capped at 104 bytes).

## Inline connectors

```yaml
connectors:
  - name: email
    exec: [node, connectors/email/dist/main.js]
    emits: [email.received]
    ops: [fetch_new, mark_read]
    config:
      user: "${secrets.email_user}"
      password: "${secrets.email_pass}"
      incoming: { protocol: imap, host: imap.example.com }
  - connectors.d          # a directory can be mixed in
```

## Daemon flags

```
247-agent-core [--config <agent.yaml>] [--log-level debug|info|warn|error]
```

`--config` defaults to `/etc/247-agent/agent.yaml`; `--log-level` overrides the file.
