# Connector manifest

Every field of a connector manifest, the built-in poller's configuration, the
environment a connector process receives, and what `oa validate` checks. How to use the
manifests is under [Connectors](../connectors/index.md).

## Every field

A manifest is one YAML file under `connectors.d/`, or an inline entry in the
`connectors` list of `agent.yaml`. Unknown keys are rejected.

```yaml
name: email                                   # [a-z][a-z0-9_-]*, unique
exec: ["247-agent-connector-email"]           # argv, no shell; the install's bin/ is first on PATH
cwd: .                                        # working directory, relative to this file
transport: stdio                              # stdio (the default for a process) | none | acp
managed_by: core                              # core (the default) | systemd
emits: [email.received]                       # the event types it publishes
ops: [fetch_new, mark_read, send]             # the ops the daemon may call; [] = any the connector lists
config:                                       # the connector's own settings, passed as OA_CONFIG_JSON
  user: "${secrets.email_user}"
  password: "${secrets.email_pass}"
  incoming: { protocol: imap, host: imap.example.com }
env: { NODE_ENV: production }                 # extra environment for the process
restart: { base: 1s, max: 60s }               # crash backoff
health: { interval: 60s, timeout: 10s, failures: 3 }   # MCP ping; stdio only
```

| Field | Meaning | Default |
|---|---|---|
| `name` | The connector's name: `[a-z][a-z0-9_-]*`, unique across every manifest and inline entry. Tasks and `defaults.agent.connector` refer to it. | required |
| `exec` | The program to run, as a list of arguments, no shell. The install's `bin/` and its Node come first on `PATH`, so a bundled connector is named by its launcher. Exactly one of `exec` and `builtin`. | one of the two |
| `builtin` | `poller`: a connector the daemon runs itself, with no process. Its `config` is the poller's (below). | none |
| `cwd` | The process's working directory, relative to the manifest file. Not for a built-in. A sandboxed agent program's `cwd` must be under `work_dir` or inside one of its binds. | the daemon's |
| `transport` | `stdio`: the process is an MCP server on stdin and stdout, serving ops. `none`: it only emits events. `acp`: it is an agent program for `agent` actions; it serves no ops, emits no events, takes no `config`. | `stdio` for a process, `none` for a built-in |
| `managed_by` | `core`: the daemon starts and supervises the process. `systemd`: it runs in its own `247-agent-connector@<name>` unit; see [A connector in its own unit](../connectors/own-unit.md). Not for a built-in or an `acp` connector. | `core` |
| `socket` | With `managed_by: systemd` and `transport: stdio` only: the absolute path where the unit serves the connector's ops and the daemon connects. | `/run/247-agent-connector/<name>/mcp.sock` |
| `emits` | The event types the connector publishes, each concrete (no wildcard). Documentation for readers of the config, not a filter. Must be empty on `acp`. A poller may omit it; if given, it must include the poller's `config.event`. | `[]` |
| `ops` | The ops a task or an agent may call on this connector. `[]` means every tool the MCP server lists. Must be empty on `transport: none` and on `acp`. | `[]` |
| `config` | The connector's own settings, defined by the connector. Passed to the process as the `OA_CONFIG_JSON` environment variable with secrets rendered. Values may use `${secrets.<name>}` and `${env.<VAR>}` only. Refused on an `acp` connector: configure an agent program through `env`. | `{}` |
| `env` | Extra environment variables for the process, with the same template rules as `config`. Not for a built-in. | `{}` |
| `sandbox` | `none`, `bwrap`, or `{ backend: bwrap, ro_binds, rw_binds, extra_args, network }`. Anything but `none` is allowed on `acp` only: every other connector needs the daemon's socket, which the sandbox hides. See below. | none |
| `restart.base` | The wait before the first respawn after a crash. Each further crash doubles it, up to `restart.max`; the count resets once the process has been up for 30 seconds. | `1s` |
| `restart.max` | The longest wait between respawns. | `60s` |
| `health.interval` | How often the daemon pings the connector's MCP server. Only on a `stdio` process connector. | none (no checks) |
| `health.timeout` | How long a ping may take. | `10s` |
| `health.failures` | Pings missed in a row before the process is treated as crashed, killed and respawned with the backoff. | `3` |

## An agent program

```yaml
name: claude
exec: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
transport: acp
env: { ANTHROPIC_API_KEY: "${secrets.anthropic_api_key}" }
sandbox:
  backend: bwrap
  ro_binds: [/var/lib/247-agent/repos/website]
  network: { allow: [api.anthropic.com, registry.npmjs.org] }
restart: { base: 1s, max: 60s }
```

### Sandbox forms

| Form | Meaning |
|---|---|
| `sandbox: none` | The program runs as the daemon's child, unconfined. Accepted on any connector. |
| `sandbox: bwrap` | The program runs in bubblewrap for its whole life: the operating system and the install read-only, `defaults.agent.work_dir` the only writable path (every run's workspace and the program's home, `<work_dir>/home/<name>`), its own process namespace, the daemon's database, socket, `agent.yaml` and secrets file hidden, and an environment of `PATH`, `HOME`, `OA_CONNECTOR_NAME` and this manifest's `env`. The host's network. |
| `sandbox.ro_binds`, `sandbox.rw_binds` | Host paths mounted inside at the same location, read-only or read-write. List every repository that `git-worktree` workspaces use in `ro_binds`. A bind may not expose the daemon's files. |
| `sandbox.extra_args` | Raw bubblewrap flags, added after the built-in ones. `--share-net` is refused together with `network`. |
| `sandbox.network.allow` | The hosts the program may reach, through a filtering proxy the daemon runs for it; everything else is refused with a 403 and logged. Needs `backend: bwrap`. Without `network` the sandbox shares the host's network; `allow: []` is no network at all. |

### `network.allow` entries

An entry is `host[:port]`. The port is a number from 1 to 65535 or `*`; without one,
443.

| Entry | Lets through |
|---|---|
| `api.anthropic.com` | that host, port 443 |
| `*.npmjs.org` | every name below `npmjs.org`, not `npmjs.org` itself, port 443 |
| `mirror.example.com:80` | that host on port 80; plain HTTP needs its port named |
| `gitea.internal:*` | that host on any port |
| `10.0.0.5:8080`, `[fd00::5]:8080` | an IPv4 or IPv6 address on that port |

Hosts are compared case-insensitively. A wildcard never matches an IP address, and a
name matched by a wildcard is refused when it resolves to a loopback, private or
link-local address; an entry that names the host or the address itself resolves
anywhere. An exact entry wins over a wildcard.

## The built-in poller

```yaml
name: github_prs
builtin: poller
config:
  schedule: "*/5 * * * *"
  connector: github
  op: list_pull_requests
  args: { repo: acme/site, state: open }
  items: pull_requests
  item_key: number
  event: github.pr_opened
  first_run: skip
  keep: 1000
  timeout: 30s
```

| Key | Meaning | Default |
|---|---|---|
| `schedule` | A cron schedule, like a cron trigger's. The first poll happens at the next scheduled time. | required |
| `tz` | The schedule's time zone. | the daemon's |
| `connector` | The process connector that serves the op. It must exist, serve ops, and list the op (or list `[]`). | required |
| `op` | The op to call. | required |
| `args` | The op's arguments. Values may use `${secrets.<name>}` and `${env.<VAR>}`; they are rendered fresh on every poll. | `{}` |
| `timeout` | The limit per call. | `60s` |
| `items` | A JMESPath over the result that yields the array of items. | the whole result |
| `item_key` | A JMESPath over one item that yields its identity, a string or a number. | required |
| `event` | The event type published once per new key, with the item as payload. The event's dedup key is `<name>:<key>` and its source the poller's name. | required |
| `first_run` | `emit`: the first poll publishes every item. `skip`: it only remembers what exists. | `emit` |
| `keep` | How many seen keys are remembered, newest last, under the state key `seen` of the poller's namespace. | `1000` |

A tick while a poll is still running is skipped. A failed poll (connector down, op
error, result not an array, item without a key) is logged and tried again at the next
tick; nothing is published and the seen list is untouched. `cwd`, `env`, `health`,
`ops` and `transport: stdio` are errors on a built-in.

## What a connector process receives

A `stdio` or `none` connector is started with these variables, plus the manifest's
`env`, on top of a minimal environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
`USER`) where `PATH` begins with the install's `bin/` and its Node:

| Variable | Value |
|---|---|
| `OA_CORE_SOCKET` | The daemon's Unix socket, for publishing events and reading or writing state. |
| `OA_CONNECTOR_NAME` | The manifest's `name`, which is also the connector's state namespace. |
| `OA_CONFIG_JSON` | The manifest's `config` as JSON, secrets rendered. |

An `acp` connector gets that minimal environment, `OA_CONNECTOR_NAME` and its `env`,
never the socket or a config. Sandboxed, its whole environment is `PATH`, `HOME` (its
own home under `work_dir`), `OA_CONNECTOR_NAME` and the manifest's `env`.

Secrets are rendered when the process starts. After rotating one, `oa connector
restart <name>` respawns the connector with the new value; the built-in poller renders
its `args` on every poll and needs nothing.

## What `oa validate` checks on a manifest

- The file parses as YAML, has `name`, and exactly one of `exec` and `builtin`. No
  unknown key.
- `name` matches the grammar and, validated from `agent.yaml`, is unique across every
  manifest and inline entry.
- `config` and `env` templates use only `${secrets.<name>}` and `${env.<VAR>}`, never
  `secrets` as a whole.
- `emits` entries and a poller's `event` are concrete event types.
- A built-in has no `cwd`, `env`, `health`, `ops`, `transport: stdio` or
  `managed_by: systemd`.
- `transport: none` serves no `ops`. An `acp` connector has empty `ops` and `emits`,
  no `config`, and is not `managed_by: systemd`.
- `health` is only on a `stdio` process connector.
- `socket` is only with `managed_by: systemd` and `transport: stdio`, and is absolute.
- A `sandbox` with a backend other than `none` is only on an `acp` connector;
  `network` needs `backend: bwrap` and no `--share-net`; every `allow` entry is
  `host[:port]` as above.
- A poller's `schedule` parses and its `tz` is known. Validated from `agent.yaml`, the
  target connector exists, serves ops and lists the op; and if `emits` is given it
  includes `config.event`.
- Validated from `agent.yaml`: a sandbox's binds do not expose the database, the
  socket, `agent.yaml` or the secrets file; a sandboxed program's `cwd` is visible
  inside the sandbox; `defaults.agent.work_dir` does not contain those files; every
  repository an `agent` task uses as a worktree is visible to its sandboxed program.
