# Running in production

How the daemon lives on a Linux server: where things are, the systemd unit and what it
protects, how secrets get in, how to change configuration, upgrade, roll back, back up
and read the logs. The [install page](../getting-started/install.md) puts all of this in
place; this page is for operating it afterwards.

## Layout

```
/opt/247-agent/            the release tree: bin/, lib/, node/, node_modules/, share/ (a symlink with the installer)
/etc/247-agent/
  agent.yaml               the daemon's configuration
  tasks.d/*.yaml           one file per workflow
  connectors.d/*.yaml      connector manifests
  prompts/*.md             system prompts for llm and agent tasks
  schemas/*.json           result schemas for agent tasks
/var/lib/247-agent/
  state.db                 SQLite: events, runs, state, the cost ledger, transcripts
  state.db.schema-<n>.bak  state.db as it was before the last upgrade that migrated it
  repos/                   base checkouts for agent worktrees
  work/<run_id>/           per-run agent workspaces, swept by retention
/run/247-agent/core.sock   the API socket, created by the daemon with mode 0660
/etc/credstore/<name>      one file per secret, root-owned, mode 0600
```

The installer and the packages give `/etc/247-agent` and the files they write to
`root:247-agent`, directories 750 and files 640: the daemon and its connectors read the
configuration and cannot change it. Give the files you add the same owner and modes
(`sudo install -m 640 -o root -g 247-agent website.yaml /etc/247-agent/tasks.d/`). The
exception is a secrets file for the `file` backend: it stays mode 600, owned by the
`247-agent` user. An upgrade gives back to root the files an older version left with the `247-agent` user, except a file the group cannot
read.

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
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
User=247-agent
Group=247-agent
ExecStart=/opt/247-agent/bin/247-agent-core --config /etc/247-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
TimeoutStartSec=300
TimeoutStopSec=90
WatchdogSec=60
RuntimeDirectory=247-agent
StateDirectory=247-agent
StateDirectoryMode=0750
ProtectSystem=strict
ReadWritePaths=/var/lib/247-agent
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

| Line | What it does for you |
|---|---|
| `StartLimitIntervalSec=600`, `StartLimitBurst=5` | a daemon that crashes again and again stops after the fifth start in ten minutes and the unit becomes `failed`, which `systemctl is-failed 247-agent` and failed-unit alerts show ([crash loops](#crash-loops)) |
| `Type=notify` | `systemctl start 247-agent` returns only once the daemon has loaded its configuration, opened the database and bound its socket; a start that fails returns an error, and units ordered `After=247-agent.service` start after that point |
| `NotifyAccess=all` | the daemon sends its notifications through `systemd-notify`, a child process |
| `User=` / `Group=` | the daemon and every connector it starts run as the unprivileged `247-agent` user |
| `ExecReload=` | `systemctl reload 247-agent` sends SIGHUP, which re-reads all configuration (below) |
| `Restart=always`, `RestartSec=5` | a crash restarts the daemon after five seconds; runs that were in flight are recovered (below) |
| `TimeoutStartSec=300` | a start may take five minutes, which leaves time for a database migration after an upgrade |
| `TimeoutStopSec=90` | systemd kills the daemon if a stop takes longer than 90 seconds; keep it above `shutdown.grace` plus 10 seconds (below) |
| `WatchdogSec=60` | the daemon reports that it is alive every 20 seconds; if it stops for a minute, systemd kills it and `Restart=always` starts it again |
| `RuntimeDirectory=` | creates `/run/247-agent` for the socket at start |
| `StateDirectory=` | creates `/var/lib/247-agent`, owned by the service user |
| `StateDirectoryMode=` | other local users cannot open `/var/lib/247-agent`, so they cannot read the database or the agent workspaces |
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
the file on the right holds the value, owned by root with mode `0600`. A name starts with
a letter and has only letters, digits and `_`: a credential named `ftp-pass` or
`ftp.pass` cannot be referenced as `${secrets.<name>}`. A connector that
runs in [its own unit](../connectors/own-unit.md) takes its `LoadCredential=` lines on that
unit instead; the daemon never resolves them.

To find every name a configuration needs:

```sh
grep -rhoE 'secrets\.[a-zA-Z0-9_]+' /etc/247-agent | sort -u
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
`sysctl kernel.unprivileged_userns_clone=1`. Ubuntu 23.10 and later set
`kernel.apparmor_restrict_unprivileged_userns=1`, which blocks bubblewrap unless an
AppArmor profile allows it. If your AppArmor ships a `bwrap-userns-restrict` profile
(AppArmor 4.1 and later), load that one, because it keeps the programs bwrap starts
confined. Otherwise, add a profile for `bwrap` and load it. Such a profile lets every
local user create user namespaces through `bwrap`, not only the service user.

```text
# /etc/apparmor.d/bwrap
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

```sh
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

To check the host before you enable a sandbox, run a minimal sandbox as the service user
with the unit's `NoNewPrivileges`:

```sh
sudo systemd-run --pty --wait -p User=247-agent -p NoNewPrivileges=yes \
  bwrap --unshare-pid --unshare-ipc --ro-bind / / true
```

The daemon runs the same check at start and on every reload when a task or an agent
connector uses `sandbox: bwrap`. When the check fails, the daemon logs
`core.sandbox_unavailable` with the cause and keeps running. A setuid `bwrap`
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
are started, removed ones stopped. No run starts while a reload applies, so runs
triggered meanwhile wait in the queue and start under the new configuration. A reload
that respawns connectors holds new runs until the connectors are up or have failed to
start: seconds for most, up to about a minute for one that hangs in setup. A connector
that fails to start shows as `down` and is retried; the reload still applies. If the
daemon cannot switch the connector set at all, it puts the previous connectors back and
the whole previous configuration stays. A run already in flight finishes under the task
definition it started with, also when it waits for a reply, retries or outlives a
restart. A run whose task you removed fails.

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
reloaded: 9 tasks; connectors: respawned email
```

When a file is invalid, nothing changes: the issues are printed as in
[`oa validate`](../reference/cli.md#oa-validate-file), with the line and the task of an
issue in a tasks file, then `reload refused: the previous config stays active`, and the
exit code is 1. When one of the three fixed keys changed, the reload still succeeds and prints
`restart required for: db` on stderr; `systemctl restart 247-agent` applies it. With
`systemctl reload` the same outcome is in the journal as `daemon.reloaded` or
`daemon.reload_needs_restart`. `systemctl reload` exits 0 even when the reload is refused;
the journal then has one error line per issue, with `file`, `path` and `issue`, and
`task` and `line` for an issue in a tasks file:
`daemon.reload_invalid` for `agent.yaml` or a manifest that is invalid on its own,
`core.config_invalid` for a tasks file or a failed cross-check between the files.

A connector in its own unit whose manifest changed and which serves no ops is the one
thing a reload cannot reach: the journal says `connector.unit_restart_needed`, and
`systemctl restart 247-agent-connector@<name>` picks up the change.

## Rotating a secret

Change the value at the backend first. Then:

| Backend | Actions, providers and pollers | Connectors |
|---|---|---|
| `systemd-credentials`, `env` | `systemctl restart 247-agent` (systemd loads credentials at start) | restarted with the daemon |
| `file` | nothing: the file is re-read on every use | `oa connector restart <name>` |

A connector receives its secrets once, when it starts. With the `file` backend, after
rotating a mailbox password, run `oa connector restart email`; it exits 1 if the
connector is not up afterwards. With `systemd-credentials`, `oa connector restart` is
not enough: systemd copies each `LoadCredential=` file into the service's credentials
directory when the service starts, so a respawned connector reads the same old copy.
With `env`, the daemon's environment is also fixed at start. The built-in poller
re-reads its secrets on every poll, so with `file` it needs nothing. A connector in its
own unit reads its own unit's credentials: restart it with
`systemctl restart 247-agent-connector@<name>`.
Runs already in flight keep the value they resolved at start.

## Upgrading and rolling back

Choose a quiet moment: `oa runs ls --status running` shows what is in flight. The
restart gives those runs `shutdown.grace` to finish; an agent run that does not finish
in time runs again from a fresh workspace after the restart.

An upgrade can migrate `state.db` to a newer schema. Before it does, the daemon copies
the database to `/var/lib/247-agent/state.db.schema-<n>.bak`, where `<n>` is the old schema
version, and keeps only the newest such copy. An older release refuses to start on the
migrated file and logs `database schema version <n> is newer than this build's <m>`. This
applies to both rollback paths below. To roll back past such an upgrade,
[restore](#backups) that copy. It holds nothing the daemon recorded after the upgrade.
Retention does not prune the copy, so it keeps payloads and transcripts from before the
upgrade until the next upgrade that migrates. Delete it once you no longer need a way
back.

Both upgrade paths check that the daemon came up. After the restart, they wait five
seconds. Then they require that the unit is active, that systemd did not restart it in
that time, and that `oa health` answers. The dispatcher and the database must not be
`failing`. Connectors that are down give only a warning. If any of these fails, the
upgrade fails and prints the rollback command. Nothing is rolled back automatically. To
run the same check yourself after a restart:

```sh
sudo sh /opt/247-agent/share/check-service.sh
```

**Package.** Install the newer `.deb` or `.rpm`. The maintainer scripts validate your
configuration with the new version, then restart a running service. If the new version
rejects the configuration, the upgrade fails and the service is not restarted. The old
daemon keeps running, but the new files are already in place: a connector it respawns,
or a restart after a crash, uses them. Fix the configuration soon. Then, for a `.deb`,
run `sudo dpkg --configure -a`. For an `.rpm`, run `sudo systemctl reset-failed 247-agent`,
then `sudo systemctl restart 247-agent` and the check above. Roll back by installing the previous file.

**Installer.** Run the installer again. It downloads the new release, unpacks it as
`/opt/247-agent-<version>`, runs the new version's `oa validate` on your existing
configuration, and only then moves the `/opt/247-agent` symlink and restarts the service
(`--no-restart` skips the restart; restart and check it yourself when no run is in
flight). The unit file is replaced, your drop-in and
`/etc/247-agent` are never touched. Roll back with:

```sh
ln -sfn /opt/247-agent-<previous version> /opt/247-agent
systemctl reset-failed 247-agent
systemctl restart 247-agent
```

Remove an old tree (`rm -rf /opt/247-agent-<previous version>`) only after the service
runs on the new version and you no longer need the rollback. Until the restart, the
running daemon uses the old tree, and the new child processes it starts need its files.

Do not mix the package and the installer on one machine: both own `/opt/247-agent`.

## Backups

### What to save

| Path | What it holds | How to save it |
|---|---|---|
| `/var/lib/247-agent/state.db` | everything the daemon knows: pending waits and approvals, poller cursors and dedup keys, state, run history, transcripts and the cost ledger | `oa backup` (below) |
| `/etc/247-agent` | the configuration: `agent.yaml`, tasks, manifests, prompts, schemas | keep it in git |
| `/etc/credstore` | the secrets | back it up where you back up root's files, encrypted |
| `/etc/systemd/system/247-agent.service.d/` | your unit drop-ins: `LoadCredential=` lines, extra `ReadWritePaths=` | with `/etc/credstore`, or in git when it holds no secret |
| `/var/lib/247-agent/.claude` | the Claude Code login of an agent logged in with a claude.ai account | with `/etc/credstore`: it is a credential |

`repos/` and `work/` under `/var/lib/247-agent` do not need a backup. Base checkouts can be
cloned again, and agent workspaces are temporary.

### Back up the database

Do not copy `state.db` and its `-wal` file while the daemon runs: the two files do not
match at any one moment. Use `oa backup` instead. It writes a consistent copy while the
daemon runs, and runs in flight continue:

```sh
oa backup /backup/state-$(date +%F).db
```

The daemon copies the database to a temporary file in `/var/lib/247-agent` and streams it
to `oa`, so that directory needs free space for one more copy of the database. The
backup file is created with mode 0600, because it holds every payload and transcript. `oa
backup` does not replace an existing file unless you add `--force`.

If `oa backup` is killed, it can leave a hidden `.<file>.<random>.partial` file next to
the target. If the daemon is killed during a backup, it can leave a
`.backup-<random>.db` file in `/var/lib/247-agent`. Delete these files. They are not
complete backups.

Back up once a day, and before each upgrade. A cursor or a wait recorded after the last
backup is lost on restore, so a mailbox poller can process the mail of that interval
again. Back up more often when that matters. A systemd timer runs the backup daily:

```ini
# /etc/systemd/system/247-agent-backup.service
[Unit]
Description=Back up the 247-agent database
Requisite=247-agent.service
After=247-agent.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'exec /opt/247-agent/bin/oa backup --force /backup/247-agent-state-$(date +%%a).db'

# /etc/systemd/system/247-agent-backup.timer
[Unit]
Description=Back up the 247-agent database daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it with `systemctl enable --now 247-agent-backup.timer`. The weekday in the file
name keeps the last seven backups.

### Restore

To restore `state.db` from an `oa backup` file or from the copy taken before a migration
(`state.db.schema-<n>.bak`):

1. Stop the service. Otherwise the daemon writes to the file while you replace it.
2. Remove the `-wal` and `-shm` files. They belong to the old database, and SQLite
   would apply them to the restored one.
3. Install the backup as `state.db`, owned by the service user, with mode 0640.
4. Start the service.

```sh
systemctl stop 247-agent
rm -f /var/lib/247-agent/state.db-wal /var/lib/247-agent/state.db-shm
install -o 247-agent -g 247-agent -m 0640 /backup/state.db /var/lib/247-agent/state.db
systemctl start 247-agent
```

The daemon treats runs that were in flight when the backup was taken as runs a restart
interrupted, and recovers them as [after a crash](#stop-crash-restart).

On a new server, install 247-agent first. Then restore `/etc/247-agent`, `/etc/credstore`,
the drop-ins and `/var/lib/247-agent/.claude` (owned by `247-agent`), run `systemctl
daemon-reload`, and restore the database as above.

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
Connector output appears as `connector.output` lines with the connector's name, at most
100 lines in 10 seconds per connector process; `connector.output_dropped` counts the rest.

At start you see, in order, `core.config_loaded`, `core.started` with how many runs were
recovered, `api.listening`, `daemon.started` and `daemon.home` with the version and the
install root. The [events reference](../reference/events.md) lists the names worth
searching for.

## Stop, crash, restart

`systemctl stop` sends SIGTERM. The daemon stops accepting, starts no new runs and
gives the runs in flight `shutdown.grace` in `agent.yaml` (30 seconds by default) to
finish. Then it aborts the rest and exits 0. An aborted attempt does not count against
the run's retry policy: the next start runs it again. If the stop is still not done 10
seconds after the grace window, the daemon logs `daemon.stop_timeout` and exits 1. After
an uncaught error it aborts the runs in flight at once and exits 1, and after 10 seconds
it exits 1 even if the stop has not finished. On the next start:

- a run aborted by a stop runs its attempt again;
- a run that was `running` when the daemon died without a clean stop (a crash, a kill,
  a power cut) is retried if its retry policy has attempts left, otherwise it is failed
  with `interrupted: the daemon restarted while the run was in progress` and
  `task.<name>.failed` is published;
- a `waiting` run keeps waiting, and one whose event arrived or whose timeout passed in
  the meantime resumes at once;
- queued runs are picked up where they were.

A socket file left by a dead daemon is replaced silently (`api.stale_socket_removed`). A
socket with a live daemon behind it refuses the start with `another daemon is listening
on /run/247-agent/core.sock` and exit 1.

### Crash loops

systemd counts every start of the unit: a start after a crash, a watchdog restart, and a
`systemctl start` or `restart`. The sixth start within ten minutes is refused. The unit
then stays `failed` with the result `start-limit-hit`, and the daemon does not run. A
single crash still restarts the daemon after five seconds, unless five starts already
happened in the last ten minutes. A loop, for example a configuration that fails at every
start, ends in `failed` within about a minute. A start that hangs until `TimeoutStartSec=`
does not loop fast enough: its starts are five minutes apart, so the unit keeps
restarting.

To find the cause and start the daemon again:

```sh
systemctl is-failed 247-agent        # prints failed
journalctl -u 247-agent -n 50 --no-pager
sudo systemctl reset-failed 247-agent
sudo systemctl start 247-agent
```

Without `reset-failed`, systemd refuses a start until ten minutes have passed since the
first counted start. An upgrade with the package or the installer resets the counter
before it starts the daemon. To change the limits, set `StartLimitIntervalSec=` and
`StartLimitBurst=` under `[Unit]` in a drop-in.

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
