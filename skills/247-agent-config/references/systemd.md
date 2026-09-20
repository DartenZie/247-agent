# Deployment on Linux with systemd

## Layout

```
/opt/247-agent/                  # the built repo (or tarball): packages/*/dist, node_modules
/etc/247-agent/
  agent.yaml
  tasks.d/*.yaml
  connectors.d/*.yaml
  prompts/*.md                   # system prompts for llm/agent tasks (cached, versioned)
  schemas/*.json                 # RESULT.json schemas
/var/lib/247-agent/
  state.db                       # SQLite, WAL
  repos/                         # base checkouts for agent worktrees
  work/<run_id>/                 # per-run worktrees, GC'd by retention
/run/247-agent/core.sock
/etc/credstore/<secret>          # one file per secret, root:root 0600
```

Keep `/etc/247-agent` in git and run `oa validate agent.yaml` in CI and before every
deploy.

## Unit

```ini
# /etc/systemd/system/247-agent.service
[Unit]
Description=247-agent core
After=network-online.target
Wants=network-online.target

[Service]
User=247-agent
Group=247-agent
ExecStart=/usr/bin/node /opt/247-agent/packages/core/dist/main.js --config /etc/247-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
LoadCredential=anthropic_api_key:/etc/credstore/anthropic_api_key
LoadCredential=imap_pass:/etc/credstore/imap_pass
LoadCredential=ftp_pass:/etc/credstore/ftp_pass
RuntimeDirectory=247-agent
StateDirectory=247-agent
ProtectSystem=strict
ReadWritePaths=/var/lib/247-agent
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

With `secrets: { backend: systemd-credentials }` each `LoadCredential=` name is a
secret of the same name. `RuntimeDirectory` creates `/run/247-agent` for the socket;
`StateDirectory` creates `/var/lib/247-agent`. Add `ReadWritePaths` for any other
directory a `shell` task writes to (a site checkout, for example).

## Install and upgrade

```
useradd --system --home /var/lib/247-agent --shell /usr/sbin/nologin 247-agent
git clone <repo> /opt/247-agent && cd /opt/247-agent && npm ci && npm run build
apt install bubblewrap          # for sandbox: bwrap on shell actions (optional)
install -d -m 750 -o 247-agent /etc/247-agent
# write agent.yaml, tasks.d/, connectors.d/ ; put secrets under /etc/credstore
node /opt/247-agent/packages/cli/dist/main.js validate /etc/247-agent/agent.yaml
systemctl daemon-reload && systemctl enable --now 247-agent
journalctl -u 247-agent -o cat -f | jq
```

Upgrade: `git pull && npm ci && npm run build`, validate, `systemctl restart 247-agent`.
Prefer restarting when no `agent` run is in flight (`GET /v1/runs?status=running`);
interrupted runs are retried per policy or failed as interrupted.

## Operating

- `oa` on the server: `alias oa='node /opt/247-agent/packages/cli/dist/main.js'`;
  the default socket path matches the unit, so no `OA_CORE_SOCKET` is needed. The
  invoking user needs write access to the socket (add them to the `247-agent` group and
  set the socket mode accordingly, or run `oa` as that user).
- Logs: JSON lines; `journalctl -u 247-agent -o cat | jq 'select(.run_id=="…")'`.
- Reload tasks: `systemctl reload 247-agent`. Connector or `agent.yaml` changes:
  `systemctl restart 247-agent`.
- Backups: `state.db` (with its `-wal` file, or via `sqlite3 .backup`) and
  `/etc/247-agent` in git.

## Hardening notes

- Core and connectors run unprivileged. Connectors needing their own privileges as
  separate units (`247-agent-connector@name`) are planned, not implemented.
- Trust model: anything running as the `247-agent` uid can reach the socket and every
  process's environment, so it is trusted. Untrusted work (agent runs, `shell` steps that
  build or test what an agent produced) runs under `sandbox: bwrap`: own pid namespace,
  OS read-only, `cwd` the only writable path, env cleared, no socket. Needs the
  `bubblewrap` package and unprivileged user namespaces
  (`sysctl kernel.unprivileged_userns_clone=1` on Debian); a setuid `bwrap` fails under
  `NoNewPrivileges=yes`, and the unit must not set `RestrictNamespaces=`. Writable paths
  still need `ReadWritePaths=` in the unit.
- Agent runs get a fresh worktree, a tool allowlist and a bash allowlist inside that
  sandbox; a network allowlist is planned.
- Inbound content is untrusted data; the capability surface, not the prompt, limits
  damage.
