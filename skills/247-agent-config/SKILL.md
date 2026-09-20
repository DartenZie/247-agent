---
name: 247-agent-config
description: "Set up and change the global configuration and deployment of a 247-agent daemon, meaning `agent.yaml` (db, socket, tasks and connectors paths, workers, log level, defaults for timeout/retry/llm/agent, budgets, retention, limits), the secrets backend (`env`, `file`, `systemd-credentials`) and how secret names are resolved, the `/etc/247-agent` layout, the systemd unit with `LoadCredential=`, hardening, and installing or upgrading the daemon on a Linux server. Use it whenever the user mentions agent.yaml, secrets, credentials, API keys, systemd, deployment, install, production, `/etc/247-agent`, `/var/lib/247-agent`, daily budget, retention, or a new environment (dev, staging, server). Also use it for self-configuration: an agent that must write or adjust its own daemon config follows this skill."
---

# 247-agent global config and deployment

One `agent.yaml` per daemon. It points at the tasks files and connector manifests,
chooses where the SQLite database and the Unix socket live, sets defaults and caps, and
names the secrets backend. Everything else lives in the tasks files
(`247-agent-tasks` skill) and manifests (`247-agent-connectors` skill).

## `agent.yaml`

```yaml
db: /var/lib/247-agent/state.db
socket: /run/247-agent/core.sock
tasks: [tasks.yaml, tasks.d]        # files and/or directories of *.yaml, merged
connectors: connectors.d            # manifest files, directories, or inline manifests
workers: 4                          # runs executing at once, globally
log: { level: info }                # debug | info | warn | error
limits: { max_event_depth: 32 }     # loop guard on causal chains
defaults:
  timeout: 15m                      # per attempt, for tasks without their own
  retry: { attempts: 3, backoff: exponential, base: 30s, max: 1h }
  sandbox: none                     # bwrap: shell actions run in bubblewrap unless they say otherwise
  llm:   { model: claude-haiku-4-5, max_tokens: 1024 }             # accepted, not applied yet
  agent: { model: claude-sonnet-5, effort: medium, max_turns: 30, budget: { max_usd: 1.0 } }
secrets: { backend: systemd-credentials }
budgets: { daily_usd: 10 }          # accepted, applied once the ledger exists
retention: { events: 90d, runs: 90d, workspaces: 7d }   # accepted, no GC yet
```

Relative `db`, `socket`, `tasks` and `connectors` paths resolve against the directory
of `agent.yaml`. Every key has a default (`references/agent-yaml.md`), so a minimal
dev file is three lines. Task names must be unique across all tasks files, connector
names across all manifests. `docs/examples/agent.yaml` is the annotated reference.

## Workflow for a new environment

1. **Choose the layout.** Production: `/etc/247-agent` for config (in git),
   `/var/lib/247-agent` for `state.db`, `repos/` and `work/`, `/run/247-agent/core.sock`.
   Development: one scratch directory with short paths (`docs/examples/hello-world/`
   shows a complete one under `/tmp/247-agent`).
2. **Write `agent.yaml`** with only the keys that differ from the defaults, plus the
   secrets backend.
3. **Provide secrets by name**, never by value in config (`references/secrets.md`).
   Collect every `${secrets.<name>}` used in tasks and manifests:

   ```
   grep -rhoE 'secrets\.[a-z0-9_]+' tasks*.yaml tasks.d connectors.d agent.yaml | sort -u
   ```

   and make sure the backend has each one. A missing secret fails the run that needs it,
   without retry, at run time, not at validate time.
4. **Validate the whole tree** from the top: `oa validate agent.yaml` follows every
   tasks file and manifest it names.
5. **Install the service** (`references/systemd.md`), `systemctl enable --now 247-agent`,
   then `journalctl -u 247-agent -o cat | jq` to watch the JSON logs.
6. **Smoke test** with `oa run <task> --wait` from the `247-agent-operate` skill.

## Changing a running daemon

| change | how it takes effect |
|---|---|
| tasks files | `systemctl reload 247-agent` (SIGHUP); running runs finish under the old config; an invalid file is logged and ignored |
| connector manifests, `agent.yaml` | restart the service |
| secrets (`file` backend) | re-read on every resolve, no restart |
| secrets (`env`, `systemd-credentials`) | restart the service (systemd re-loads credentials at start) |

Run `oa validate agent.yaml` before any reload or restart; CI should run it on the
config repo.

## Self-configuration rules

When an agent edits the daemon's own configuration:

- Never write a secret value anywhere: not in YAML, not in a log, not in an event. Add
  the secret by name and tell the human which backend entry to create.
- Prefer adding a tasks file under `tasks.d/` over editing an existing one; the loader
  merges them and uniqueness is checked.
- Keep `docs/examples/*.yaml` and `docs/examples/connectors.d/*.yaml` valid if the
  repo's examples are touched.
- Validate, then reload. Never restart while an `agent` run is in flight unless the
  human asked; it will be retried from a fresh worktree or fail as interrupted.
- Budgets and caps go down easily and up only with the human's say-so.

Source of truth: `docs/USER-GUIDE.md` §4.1, §4.6, §9; `docs/ARCHITECTURE.md` §7, §11, §12;
`packages/core/src/config/agent.ts`.
