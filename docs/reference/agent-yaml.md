# `agent.yaml`

Every key of the daemon's global configuration file, with its default. Tasks live in
the files `tasks` names ([task reference](task.md)); connectors in the manifests
`connectors` names ([manifest reference](manifest.md)).

## Every key with its default

Unknown keys are rejected. An empty file is valid: every key has a default or is
optional.

```yaml
# Paths are relative to this file.
db: /var/lib/247-agent/state.db
socket: /run/247-agent/core.sock
tasks: tasks.yaml                    # a file, a directory of *.yaml, or a list of both
connectors: []                       # manifest files, directories, or inline manifests
workers: 4
log: { level: info }
limits: { max_event_depth: 32 }
defaults:
  timeout: 15m
  retry: { attempts: 1, backoff: exponential, base: 30s, max: 1h }
  sandbox: none
  llm: { max_tokens: 1024 }          # provider, model and effort have no default
  decide: { model: typesafe/jev-1.13 }   # provider has no default
  agent: { max_tool_calls: 40 }      # connector, budget and work_dir: see below
secrets: { backend: env, prefix: OA_SECRET_ }
providers: {}
pricing: {}
budgets: {}                          # daily_usd has no default: no daily cap
batches: { poll: 1m }
retention: { events: 90d, runs: 90d, ledger: 90d, workspaces: 7d, interval: 1h }
```

Durations are an integer and a unit: `500ms`, `30s`, `15m`, `24h`, `7d`.

## Top level

| Key | Meaning | Default |
|---|---|---|
| `db` | The SQLite file holding events, runs, state, the cost ledger and agent transcripts. | `/var/lib/247-agent/state.db` |
| `socket` | The Unix socket the API and `oa` use. The directory `<socket>.net` beside it holds the sockets of sandboxed agents' network proxies. | `/run/247-agent/core.sock` |
| `tasks` | A tasks file, a directory (its `*.yaml` and `*.yml` files, in name order), or a list of both. All are merged; task names must be unique across them; at least one file must exist. | `tasks.yaml` |
| `connectors` | Manifest files, directories of manifests, or inline manifests (objects in the list). Connector names must be unique across all of them. | none |
| `workers` | Runs executing at the same time, across every task. | `4` |
| `log.level` | `debug`, `info`, `warn` or `error`. `247-agent-core --log-level` overrides it. | `info` |
| `limits.max_event_depth` | An event deeper than this in a causal chain (hops from the root event) starts no run. It still ends a `wait` that matches it. | `32` |

## Defaults for tasks

| Key | Meaning | Default |
|---|---|---|
| `defaults.timeout` | Wall-clock limit per attempt of active work, for tasks without `timeout`. Time spent `waiting` does not count. | `15m` |
| `defaults.retry` | Retry policy for tasks without `retry`: `attempts` (1 to 100), `backoff` (`fixed` or `exponential`), `base`, `max`. | `{ attempts: 1, backoff: exponential, base: 30s, max: 1h }` |
| `defaults.sandbox` | Sandbox for `shell` actions, and for agent `post` gates, that have no `sandbox` of their own: `none`, `bwrap`, or `{ backend: bwrap, ro_binds: [], rw_binds: [], extra_args: [] }`. A bind may not expose the database, the socket, this file or the secrets file. | `none` |
| `defaults.llm.provider` | The provider for `llm` actions without `provider`. | none |
| `defaults.llm.model` | The model for `llm` actions without `model`. | none |
| `defaults.llm.max_tokens` | The output cap for `llm` actions without `max_tokens`, 1 to 128000. | `1024` |
| `defaults.llm.effort` | `low`, `medium` or `high`, for `llm` actions without `effort`. | none |
| `defaults.decide.provider` | The provider for `decide` actions without `provider`. It must be of type `openrouter`. | none |
| `defaults.decide.model` | The model for `decide` actions without `model`. | `typesafe/jev-1.13` |
| `defaults.agent.connector` | The agent program (a `transport: acp` connector) for `agent` actions without `connector`. | none |
| `defaults.agent.max_tool_calls` | The tool-call cap for `agent` actions without their own. | `40` |
| `defaults.agent.budget.max_usd` | The per-run dollar cap for `agent` actions without their own `budget`. | none |
| `defaults.agent.work_dir` | Where run workspaces go, as `<work_dir>/<run_id>`. It is also the one writable path of a sandboxed agent program, whose home is `<work_dir>/home/<connector>`. It must not contain the database, the socket, this file or the secrets file. | `work/` next to the database |

## Secrets

`secrets` names the backend that turns a `${secrets.<name>}` reference into a value.
Secret names are `[a-zA-Z][a-zA-Z0-9_]*`. Which backend to use is fixed for the life
of the process.

| Key | Meaning | Default |
|---|---|---|
| `secrets.backend` | `env`, `file` or `systemd-credentials`. | `env` |
| `secrets.prefix` (`env` only) | A secret `ftp_pass` is read from the environment variable `<prefix>FTP_PASS` (the name upper-cased). Variables starting with the prefix are hidden from `${env.…}` templates. | `OA_SECRET_` |
| `secrets.path` (`file` only) | A YAML or JSON map of name to value, relative to this file, re-read on every use. It must be mode `0600`: a file readable by the group or others fails every resolve. | required |
| `secrets.dir` (`systemd-credentials` only) | A directory with one file per secret; one trailing newline is stripped. | `$CREDENTIALS_DIRECTORY`, which systemd sets from the unit's `LoadCredential=` lines |

## Providers and prices

```yaml
providers:
  anthropic:  { type: anthropic,  api_key: "${secrets.anthropic_api_key}" }
  openai:     { type: openai,     api_key: "${secrets.openai_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}", headers: { X-Title: 247-agent } }
pricing:
  gpt-4.1-mini: { input: 0.4, output: 1.6 }   # USD per million tokens
```

| Key | Meaning | Default |
|---|---|---|
| `providers.<name>` | A model API account. Names are `[a-z][a-z0-9_]*`; `llm` and `decide` actions pick one with `provider`. | `{}` |
| `providers.<name>.type` | `anthropic`, `openai` or `openrouter`. Only `openrouter` serves `decide`; only `anthropic` serves `batch: true`. | required |
| `providers.<name>.api_key` | Exactly one secret reference, `"${secrets.<name>}"`. A literal key is refused. | required |
| `providers.<name>.base_url` | A URL replacing the provider's default endpoint. | the provider's own |
| `providers.<name>.headers` | Extra request headers. Values may use `${secrets.<name>}` and `${env.<VAR>}` only. | `{}` |
| `pricing.<model>` | `{ input, output, cache_read, cache_write }` in USD per million tokens, merged over the built-in table below. A model the table does not know needs `input` and `output`; a missing cache price defaults to `input`. | `{}` |

The built-in table. Anthropic cache writes cost 1.25 times and cache reads 0.1 times
the input price. OpenAI prices were checked on 2026-09-20 and the Jev price on
2026-09-21.

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| `claude-haiku-4-5` | 1 | 5 | 0.1 | 1.25 |
| `claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 |
| `claude-opus-5` | 5 | 25 | 0.5 | 6.25 |
| `gpt-6-astra` | 10 | 50 | 1 | 10 |
| `gpt-5.6-terra` | 2 | 12 | 0.2 | 2 |
| `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | 0.2 |
| `gpt-5.5` | 5 | 30 | 0.5 | 5 |
| `gpt-5.4` | 2.5 | 15 | 0.25 | 2.5 |
| `gpt-5.4-mini` | 0.75 | 4.5 | 0.075 | 0.75 |
| `gpt-5.4-nano` | 0.2 | 1.25 | 0.02 | 0.2 |
| `gpt-5` | 1.25 | 10 | 0.125 | 1.25 |
| `gpt-5-mini` | 0.25 | 2 | 0.025 | 0.25 |
| `gpt-5-nano` | 0.05 | 0.4 | 0.005 | 0.05 |
| `typesafe/jev-1.13` | 0.042 | 0 | 0.042 | 0.042 |
| `~typesafe/jev-latest` | 0.042 | 0 | 0.042 | 0.042 |

A model on an `openrouter` provider needs no entry: every response reports its own
cost. A call sent with `batch: true` is billed at half of every price. A model with no
price on an `anthropic` or `openai` provider fails `oa validate`.

## Budgets, batches, retention

| Key | Meaning | Default |
|---|---|---|
| `budgets.daily_usd` | A cap on model spend per UTC day, summed from the ledger. Once crossed, every model call fails fast until 00:00 UTC and one `budget.exceeded` event is published for the day. | none |
| `batches.poll` | How often `llm` actions with `batch: true` are checked for their result, `1s` to `1h`. | `1m` |
| `retention.events` | How long a dispatched event is kept once no kept run or wait references it. A duration or `never`. | `90d` |
| `retention.runs` | How long a finished run is kept, with its ledger rows and transcript. A duration of at least `1d`, or `never`. | `90d` |
| `retention.ledger` | How long the ledger rows of finished runs are kept. At least `1d`; it cannot exceed `runs`. | the value of `runs` |
| `retention.workspaces` | How long the `<work_dir>/<run_id>` directory of a finished run is kept. | `7d` |
| `retention.interval` | How often the retention pass runs. It also runs once at start. | `1h` |

Active runs, their events and their workspaces are never deleted, whatever the
durations.

## What changes on reload

`oa reload` (or `systemctl reload 247-agent`) re-reads this file, every manifest and
every tasks file and applies them together, or not at all when any file is invalid.
Every key applies live, with three exceptions: a changed `db`, `socket` or `secrets`
is reported as requiring a restart, and the running values stay. Runs already in
flight finish under the settings they started with. A changed `defaults.agent.work_dir`
respawns every sandboxed agent program, since the sandbox mounts that directory.

## Relative paths

These resolve against the directory that holds `agent.yaml`: `db`, `socket`, every
entry of `tasks` and `connectors`, `defaults.agent.work_dir`, `secrets.path`,
`secrets.dir`, and the `system_file` and `result.schema` paths of `llm` and `agent`
actions, which must also stay under that directory.
