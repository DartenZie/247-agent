# Running in production

How the daemon lives on a Linux server: where things are, the systemd unit and what it
protects, how secrets get in, how to change configuration, upgrade, roll back, back up
and read the logs. The [install page](../getting-started/install.md) puts all of this in
place; this page is for operating it afterwards.

## Layout

```
/opt/247-agent/          the release tree: bin/, lib/, node/, node_modules/, share/ (a symlink with the installer)
/etc/247-agent/
  agent.yaml             the daemon's configuration
  tasks.d/*.yaml         one file per workflow
  connectors.d/*.yaml    connector manifests
  prompts/*.md           system prompts for llm and agent tasks
  schemas/*.json         result schemas for agent tasks
/var/lib/247-agent/
  state.db               SQLite: events, runs, state, the cost ledger, transcripts
  repos/                 base checkouts for agent worktrees
  work/<run_id>/         per-run agent workspaces, swept by retention
/run/247-agent/core.sock the API socket, created by the daemon with mode 0660
/etc/credstore/<name>    one file per secret, root-owned, mode 0600
```

Keep `/etc/247-agent` in git. Run `oa validate /etc/247-agent/agent.yaml` in CI and before
every deploy; it follows the file to every tasks file and manifest it names and needs no
running daemon.

## The unit

The package and the installer both ship this unit, and the release carries it as
`share/systemd/247-agent.service`:

```ini
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

| Line | What it does for you |
|---|---|
| `User=` / `Group=` | the daemon and every connector it starts run as the unprivileged `247-agent` user |
| `ExecReload=` | `systemctl reload 247-agent` sends SIGHUP, which re-reads all configuration (below) |
| `Restart=always`, `RestartSec=5` | a crash restarts the daemon after five seconds; runs that were in flight are recovered (below) |
| `RuntimeDirectory=` | creates `/run/247-agent` for the socket at start |
| `StateDirectory=` | creates `/var/lib/247-agent`, owned by the service user |
| `ProtectSystem=strict` | the whole file system is read-only to the service except what `ReadWritePaths=` lists |
| `ReadWritePaths=` | the state directory is writable; add any other directory a `shell` task writes to, such as a site checkout |
| `PrivateTmp=yes` | the service has its own `/tmp` |
| `NoNewPrivileges=yes` | nothing the service starts can gain privileges, not even a setuid binary |

Local changes belong in a drop-in, never in the shipped file: `systemctl edit 247-agent`
opens one, and an upgrade replaces the unit without touching it.

## Secrets

With `secrets: { backend: systemd-credentials }` in `agent.yaml`, each secret is a file
systemd hands to the service by name. Put one `LoadCredential=` line per name your tasks
and manifests use in the drop-in:

```ini
[Service]
LoadCredential=anthropic_api_key:/etc/credstore/anthropic_api_key
LoadCredential=email_pass:/etc/credstore/email_pass
LoadCredential=ftp_pass:/etc/credstore/ftp_pass
```

The name on the left is the secret's name in your configuration (`${secrets.ftp_pass}`);
the file on the right holds the value, owned by root with mode `0600`. A connector that
runs in [its own unit](../connectors/own-unit.md) takes its `LoadCredential=` lines on that
unit instead; the daemon never resolves them.

To find every name a configuration needs:

```sh
grep -rhoE 'secrets\.[a-z0-9_]+' /etc/247-agent | sort -u
```

A missing secret fails the run that needs it, without a retry, at run time rather than at
validation.

## Who may run `oa`

The daemon creates the socket with mode `0660`, owned by `247-agent:247-agent`. Run `oa`
as root with `sudo`, as the service user, or add your account to the `247-agent` group.
On the server the default socket path matches the unit, so no `--socket` or
`OA_CORE_SOCKET` is needed.

## Sandboxing needs bubblewrap

`sandbox: bwrap` on a shell action, `defaults.sandbox: bwrap`, and the agent program's
manifest sandbox all need the `bubblewrap` package (`apt install bubblewrap`; the
packages recommend it) and unprivileged user namespaces. Older Debian needs
`sysctl kernel.unprivileged_userns_clone=1`; elsewhere it is the default. A setuid `bwrap`
does not work under `NoNewPrivileges=yes`, and the unit must not set
`RestrictNamespaces=`. Directories a sandboxed step or agent writes to still need
`ReadWritePaths=` in the unit, because the sandbox lives inside the service's own mount
namespace; the agents' `work_dir` under `/var/lib/247-agent` is already covered.

Without bubblewrap a sandboxed shell step fails and a sandboxed agent connector stays
`down` with the spawn error in `oa connector list`.

## Changing configuration: reload or restart

Everything in `agent.yaml`, the tasks files and the manifests is re-read and applied
together by `oa reload` or `systemctl reload 247-agent`. Workers, defaults, providers,
prices, budgets, retention, the log level, limits and the tasks take effect at once.
Connectors whose manifest changed are respawned with freshly resolved secrets, new ones
are started, removed ones stopped. Runs already in flight finish under the configuration
they started with.

Three keys cannot change live: `db`, `socket` and `secrets`. A reload that touches them
applies everything else and reports them.

```sh
oa validate /etc/247-agent/agent.yaml     # always first
oa reload
```

```
ok /etc/247-agent/agent.yaml
ok /etc/247-agent/connectors.d/email.yaml
ok /etc/247-agent/tasks.d/website.yaml
reloaded: 8 tasks; connectors: respawned email
```

When a file is invalid, nothing changes: the issues are printed as `<file>: <path>:
<message>`, then `reload refused: the previous config stays active`, and the exit code is
1. When one of the three fixed keys changed, the reload still succeeds and prints
`restart required for: db` on stderr; `systemctl restart 247-agent` applies it. With
`systemctl reload` the same outcome is in the journal as `daemon.reloaded`,
`daemon.reload_invalid` or `daemon.reload_needs_restart`.

A connector in its own unit whose manifest changed and which serves no ops is the one
thing a reload cannot reach: the journal says `connector.unit_restart_needed`, and
`systemctl restart 247-agent-connector@<name>` picks up the change.

## Rotating a secret

Change the value at the backend first. Then:

| Backend | Actions, providers and pollers | Connectors |
|---|---|---|
| `systemd-credentials`, `env` | `systemctl restart 247-agent` (systemd loads credentials at start) | restarted with the daemon |
| `file` | nothing: the file is re-read on every use | `oa connector restart <name>` |

A connector receives its secrets once, when it starts, so after rotating a mailbox
password run `oa connector restart email`; it exits 1 if the connector is not up
afterwards. The built-in poller re-reads its secrets on every poll and needs nothing. A
connector in its own unit is restarted with `systemctl restart 247-agent-connector@<name>`.
Runs already in flight keep the value they resolved at start.

## Upgrading and rolling back

Choose a quiet moment: `oa runs ls --status running` shows what is in flight. An
interrupted agent run is retried from a fresh workspace if its retry policy allows, and
failed as interrupted otherwise.

**Package.** Install the newer `.deb` or `.rpm`; the maintainer scripts restart a running
service. Roll back by installing the previous file.

**Installer.** Run the installer again. It downloads the new release, unpacks it as
`/opt/247-agent-<version>`, runs the new version's `oa validate` on your existing
configuration, and only then moves the `/opt/247-agent` symlink and restarts the service
(`--no-restart` skips the restart). The unit file is replaced, your drop-in and
`/etc/247-agent` are never touched. Roll back with:

```sh
ln -sfn /opt/247-agent-<previous version> /opt/247-agent
systemctl restart 247-agent
```

Do not mix the package and the installer on one machine: both own `/opt/247-agent`.

## Backups

- `/etc/247-agent` in git is the configuration backup.
- `/var/lib/247-agent/state.db` holds everything the daemon knows. Copy it with its `-wal`
  file while the daemon runs, or take a consistent snapshot with `sqlite3
  /var/lib/247-agent/state.db ".backup /backup/state.db"`.
- `/etc/credstore` holds the secrets; back it up where you back up root's files.

## Logs

The daemon writes one JSON object per line to stdout, which journald keeps:

```sh
journalctl -u 247-agent -o cat -f | jq            # follow everything
journalctl -u 247-agent -o cat | jq 'select(.run_id=="run_01J…")'            # one run
journalctl -u 247-agent -o cat | jq 'select(.correlation_id=="cor_01J…")'    # one story, across tasks
journalctl -u 247-agent -o cat | jq 'select(.level=="error" or .level=="warn")'
```

Every line has `ts`, `level` and `msg`, the event name such as `run.started`,
`wait.matched`, `connector.exited` or `sandbox.net_denied`. Every line about a run also
carries `run_id`, `task` and `correlation_id`, and the correlation id is shared by every
task the same real-world event caused, so one `select` shows an email's whole path.
Connector output appears as `connector.output` lines with the connector's name.

At start you see, in order, `core.config_loaded`, `core.started` with how many runs were
recovered, `api.listening`, `daemon.started` and `daemon.home` with the version and the
install root. The [events reference](../reference/events.md) lists the names worth
searching for.

## Stop, crash, restart

`systemctl stop` sends SIGTERM. The daemon stops accepting, aborts the attempts in
flight and exits 0. On the next start:

- a run that was `running` is retried if its retry policy has attempts left, otherwise
  it is failed with `interrupted: the daemon restarted while the run was in progress`
  and `task.<name>.failed` is published;
- a `waiting` run keeps waiting, and one whose event arrived or whose timeout passed in
  the meantime resumes at once;
- queued runs are picked up where they were.

A socket file left by a dead daemon is replaced silently (`api.stale_socket_removed`). A
socket with a live daemon behind it refuses the start with `another daemon is listening
on /run/247-agent/core.sock` and exit 1.

## Daemon flags

```
247-agent-core [--config <agent.yaml>] [--log-level debug|info|warn|error] [--version]
```

`--config` defaults to `/etc/247-agent/agent.yaml`. `--log-level` overrides `log.level`
from the file and keeps doing so across reloads. The launcher sets `OA_HOME` to the
install root; the daemon puts `<OA_HOME>/bin` and its own Node first on `PATH` for every
connector and shell action, which is how a manifest's `exec: ["247-agent-connector-email"]`
finds the bundled program wherever the tree lives.

Next: [Monitoring](monitoring.md), [Troubleshooting](troubleshooting.md).
