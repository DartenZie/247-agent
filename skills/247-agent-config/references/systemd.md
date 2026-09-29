# Deployment on Linux with systemd

## Layout

```
/opt/247-agent/                  # the unpacked release tarball: bin/, lib/, node/, node_modules/, share/
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

Shipped as `/opt/247-agent/share/systemd/247-agent.service` (`packaging/247-agent.service`
in the repository). Secrets are added in a drop-in (`systemctl edit 247-agent`), one
`LoadCredential=<name>:/etc/credstore/<name>` per secret the tasks and manifests use,
so the shipped unit never references files that may not exist.

```ini
# /etc/systemd/system/247-agent.service
[Unit]
Description=247-agent core
After=network-online.target
Wants=network-online.target

[Service]
User=247-agent
Group=247-agent
ExecStart=/opt/247-agent/bin/247-agent-core --config /etc/247-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
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

On Debian, Ubuntu or Fedora the package is the normal path; installing a newer file
upgrades, `apt remove` keeps config, state, drop-ins and the user, `apt purge` removes
them:

```
apt install ./247-agent_<version>-1_amd64.deb      # dnf install ./247-agent-<version>-1.x86_64.rpm
```

Elsewhere the installer script does the same things from the tarball; run it again to
upgrade (never mix the two on one machine, both own /opt/247-agent):

```
curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh -s -- --version 0.2.0
sh /opt/247-agent/share/uninstall.sh [--purge]      # keeps config, state, drop-ins, user unless --purge
```

It verifies the tarball's checksum, installs `/opt/247-agent-<version>` with
`/opt/247-agent` as a symlink (rollback: `ln -sfn` the old tree, restart), links
`/usr/local/bin/oa`, creates the user and a starter `/etc/247-agent` once, replaces the
unit file (keep local changes in `systemctl edit 247-agent`), validates the existing
config with the new version before switching, and restarts a running service unless
`--no-restart`. `--from <tarball>` installs a local build, `--no-service` only the tree.

By hand:

```
useradd --system --home /var/lib/247-agent --shell /usr/sbin/nologin 247-agent
tar -xzf 247-agent-<version>-linux-x64.tar.gz   # from the GitHub release of tag v<version>
mv 247-agent-<version>-linux-x64 /opt/247-agent
ln -s /opt/247-agent/bin/oa /usr/local/bin/oa
apt install bubblewrap          # for sandbox: bwrap on shell actions (optional)
install -d -m 750 -o 247-agent /etc/247-agent
# write agent.yaml, tasks.d/, connectors.d/ ; put secrets under /etc/credstore
cp /opt/247-agent/share/systemd/247-agent.service /etc/systemd/system/
systemctl edit 247-agent        # drop-in with one LoadCredential= per secret
oa validate /etc/247-agent/agent.yaml
systemctl daemon-reload && systemctl enable --now 247-agent
journalctl -u 247-agent -o cat -f | jq
```

The tarball is self-contained (bundled code, vendored Node, the SQLite addon); the
machine needs nothing else. Manifests name the bundled connectors by launcher,
`exec: ["247-agent-connector-email"]`, since the daemon puts `/opt/247-agent/bin` and
its Node first on `PATH` for every child. A source checkout has the same `bin/`, so the
same manifests work in development; `npm run release` builds the tarball
(`scripts/build-release.sh --target linux-x64` cross-builds from a Mac).

Upgrade: unpack the new tarball as `/opt/247-agent-<version>`, repoint `/opt/247-agent`
(a symlink is easiest), `oa validate`, `systemctl restart 247-agent`.
Prefer restarting when no `agent` run is in flight (`GET /v1/runs?status=running`);
interrupted runs are retried per policy or failed as interrupted.

## Operating

- `oa` on the server: `/opt/247-agent/bin/oa` (symlinked to `/usr/local/bin/oa`
  above); the default socket path matches the unit, so no `OA_CORE_SOCKET` is needed. The
  invoking user needs write access to the socket (add them to the `247-agent` group and
  set the socket mode accordingly, or run `oa` as that user).
- Logs: JSON lines; `journalctl -u 247-agent -o cat | jq 'select(.run_id=="…")'`.
- Reload config (tasks, manifests, `agent.yaml`): `oa reload` (prints the outcome) or
  `systemctl reload 247-agent`. Only `db`, `socket` and `secrets` need
  `systemctl restart 247-agent`.
- Metrics: `oa metrics` prints `GET /metrics`; Prometheus cannot scrape the socket, so
  write it to a node_exporter textfile on a timer or proxy the socket over HTTP.
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
