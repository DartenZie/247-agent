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
| `defaults.sandbox` | `none`, `bwrap`, or `{backend: bwrap, ro_binds, rw_binds, extra_args}` for `shell` actions without `sandbox` | `none` |
| `defaults.llm` | `{provider?, model?, max_tokens, effort?}` for `llm` actions without their own | `max_tokens: 1024` |
| `defaults.decide` | `{provider?, model}` for `decide` actions without their own; the provider must be an `openrouter` one | `model: typesafe/jev-1.13` |
| `defaults.agent` | `{connector, max_tool_calls, budget, work_dir}` | `agent` actions: the acp connector, the tool-call cap (40), the budget, and where run workspaces go (`work/` next to `db`). `work_dir` is also the one writable path of a sandboxed agent program (its home is `<work_dir>/home/<connector>`), so it must not contain `db`, `socket`, `agent.yaml` or the secrets file; changing it respawns sandboxed agents |
| `secrets` | `{backend: env, prefix?}`, `{backend: file, path}`, `{backend: systemd-credentials}` | `{backend: env}` |
| `providers` | `name: {type: anthropic\|openai\|openrouter, api_key: "${secrets.x}", base_url?, headers?}`; `llm` and `decide` actions pick one with `provider:` | none |
| `pricing` | `model: {input, output, cache_read?, cache_write?}` USD per Mtok, merged over the built-in table (Claude, current OpenAI, Jev); a model without a price fails validation unless its provider reports cost | `{}` |
| `budgets.daily_usd` | Global cap per UTC day; once crossed, model calls fail fast until midnight and `budget.exceeded` is emitted once | none |
| `batches.poll` | How often the Message Batches of `llm` actions with `batch: true` are checked; an ended one is ledgered and published as `llm.batch.ended` | `1m` |
| `retention` | `{events, runs, ledger, workspaces, interval}`: how long events, finished runs (with their ledger rows), ledger rows and `work/<run_id>` directories are kept; durations or `never`; `ledger` defaults to `runs` and cannot exceed it; a pass runs at start and every `interval`; active runs are never touched | `90d`, `90d`, `90d`, `7d`, `1h` |

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

## Providers for `llm` and `decide` actions

```yaml
providers:
  anthropic:  { type: anthropic, api_key: "${secrets.anthropic_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}", headers: { X-Title: 247-agent } }
pricing: { gpt-5-mini: { input: 0.25, output: 2 } }
defaults:
  llm: { provider: anthropic, model: claude-haiku-4-5 }
  decide: { provider: openrouter }        # model defaults to typesafe/jev-1.13
budgets: { daily_usd: 10 }
```

`api_key` must be exactly one `${secrets.<name>}`; `headers` values may use secrets and
`${env.X}`. `oa validate agent.yaml` cross-checks every `llm` and `decide` task: the
provider exists, the model has a price (OpenRouter excepted), an `llm` task's
`system_file` exists under the config dir, and a `decide` task's provider is of type
`openrouter` (the only one that serves the Decisions API Jev lives behind).

## Inline connectors

```yaml
connectors:
  - name: email
    exec: [247-agent-connector-email]
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
