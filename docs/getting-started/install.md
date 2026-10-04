# Install

This page gets the daemon onto a Linux server, or into a checkout for development, and
shows you how to tell it is running. Pick one of the three ways; they install the same
tree and the same systemd unit.

Every release is self-contained: the bundled programs, a pinned Node.js, the SQLite
addon, the documentation, the examples and the agent skills. Nothing else has to be
installed. The one optional extra is the `bubblewrap` package, which you need only when
you sandbox shell steps or agent programs (see [Security](../concepts/security.md)).

## The package: Debian, Ubuntu, Fedora

Download the `.deb` or `.rpm` for your architecture from the
[latest release](https://github.com/DartenZie/247-agent/releases/latest) and install
it with your package manager:

```sh
sudo apt install ./247-agent_<version>-1_amd64.deb
# or, on Fedora and friends:
sudo dnf install ./247-agent-<version>-1.x86_64.rpm
```

For example, with the first release and an `amd64` machine:

```sh
curl -fsSLO https://github.com/DartenZie/247-agent/releases/download/v0.1.0/247-agent_0.1.0-1_amd64.deb
sudo apt install ./247-agent_0.1.0-1_amd64.deb
```

The package:

- puts the release tree under `/opt/247-agent` and links `/usr/bin/oa`;
- installs the service unit `/usr/lib/systemd/system/247-agent.service` and the
  template unit for connectors that run on their own;
- creates the `247-agent` system user;
- writes a starter configuration to `/etc/247-agent` (`agent.yaml`, one task in
  `tasks.d/hello.yaml`, an empty `connectors.d/`), as configuration files the package
  manager never overwrites;
- on a fresh install, enables and starts the service; on an upgrade, restarts it.

To upgrade, install the newer file the same way. `apt remove` keeps your configuration,
the state database, any unit drop-ins and the user; `apt purge` removes those too.
Secrets under `/etc/credstore` are never touched. Packages exist for `arm64` and
`aarch64` as well.

## The installer script: any other Linux

One command downloads the release tarball for your architecture and does what the
package does:

```sh
curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh
```

Run it as root or with `sudo` rights. It:

- picks the latest release for the machine's architecture and verifies the checksum;
- unpacks it to `/opt/247-agent-<version>` and points the symlink `/opt/247-agent` at
  it;
- links `oa` into `/usr/local/bin`;
- creates the `247-agent` user and, once, the starter `/etc/247-agent`;
- installs the units and starts the service.

Run it again to upgrade. The new version validates your existing configuration before
the symlink moves, the unit file is replaced (keep local changes in
`systemctl edit 247-agent`), your configuration is never touched, and the service
restarts unless you pass `--no-restart`. To roll back, point the symlink at the old
tree and restart:

```sh
sudo ln -sfn /opt/247-agent-<old version> /opt/247-agent
sudo systemctl restart 247-agent
```

Options, passed after `sh -s --`:

| Option | Effect |
|---|---|
| `--version <v>` | install that release instead of the latest |
| `--from <tarball>` | install a local tarball, such as one you built with `npm run release` |
| `--prefix <dir>` | somewhere other than `/opt` |
| `--bin-dir <dir>` | where to link `oa` |
| `--no-service` | only the tree and the symlinks: no user, no `/etc`, no unit. Also for macOS and user-local installs, which then need no `sudo` |
| `--no-restart` | leave a running daemon alone after an upgrade |

`sh /opt/247-agent/share/uninstall.sh` removes what the installer put there and keeps
the configuration, state, drop-ins and user; add `--purge` to remove those too.

> [!WARNING]
> Do not mix the installer with the package on one machine. Both own `/opt/247-agent`.

If you prefer to do it by hand, the tarball unpacks to one directory and `bin/` is the
whole interface:

```sh
curl -fsSLO https://github.com/DartenZie/247-agent/releases/download/v<version>/247-agent-<version>-linux-x64.tar.gz
tar -xzf 247-agent-<version>-linux-x64.tar.gz
sudo mv 247-agent-<version>-linux-x64 /opt/247-agent
sudo ln -s /opt/247-agent/bin/oa /usr/local/bin/oa
oa --version
```

[Production](../operations/production.md) covers the user, the unit and the
credentials you then set up yourself.

## From source: development

You need Node.js 22 or newer, npm and git. Linux is the target; macOS works for
development.

```sh
git clone https://github.com/DartenZie/247-agent.git && cd 247-agent
npm install
npm run build
npm test            # optional; needs no network
```

The checkout has the same launchers as a release: `bin/oa` and `bin/247-agent-core`
run the workspace build under the Node on your `PATH`. Everything in this
documentation works the same way from a checkout. `npm run release` builds the release
tarball for your machine into `dist-release/`.

## What got installed

The release tree, under `/opt/247-agent` or wherever you unpacked it:

| Path | What |
|---|---|
| `bin/247-agent-core` | the daemon, the always-on process |
| `bin/oa` | the command-line tool |
| `bin/247-agent-connector-<name>` | the bundled connectors (`email`, `ftp`, `chat`, `webhook`, `github`, `jira`), which manifests name by this launcher |
| `bin/247-agent-connector-host` | runs one connector in its own systemd unit |
| `lib/`, `node/`, `node_modules/` | the bundled code, the vendored Node.js (with `npm` and `npx`), the SQLite addon |
| `share/doc/` | this documentation |
| `share/examples/` | the example configuration, including the reference workflow |
| `share/skills/` | the agent skills, for an agent that configures the daemon it runs under |
| `share/systemd/` | the two unit files |
| `share/etc/` | the starter configuration |
| `share/install.sh`, `share/uninstall.sh` | the installer and its counterpart |
| `VERSION` | version, target and Node.js version of the build |

The tree is relocatable: every launcher finds its siblings from its own location, and
the daemon puts `bin/` first on the `PATH` of everything it starts.

On a server, the daemon uses these paths:

| Path | What |
|---|---|
| `/etc/247-agent/agent.yaml` | the global configuration |
| `/etc/247-agent/tasks.d/*.yaml` | your tasks, one file per workflow |
| `/etc/247-agent/connectors.d/*.yaml` | connector manifests |
| `/etc/247-agent/prompts/`, `schemas/` | prompts and schemas your tasks refer to |
| `/var/lib/247-agent/state.db` | the SQLite database: events, runs, state, cost |
| `/var/lib/247-agent/work/` | agent workspaces |
| `/run/247-agent/core.sock` | the Unix socket the CLI talks to |

## Check it works

The starter configuration has one task, `hello`, with no schedule: it runs only when
you ask. The socket belongs to the service user, so run `oa` with `sudo` or add
yourself to the `247-agent` group.

```sh
sudo oa run hello --wait
```

```
succeeded run_01M43ZV28DEK6X07KQFGD1X7R3 for hello
"hello from 247-agent, run run_01M43ZV28DEK6X07KQFGD1X7R3"
```

The first line is the run's status and id; the second is the task's result. The daemon
logs JSON lines to the journal, one per line, so you can watch it work:

```sh
journalctl -u 247-agent -o cat -f | jq
```

From here, [Your first task](first-task.md) walks you through writing tasks of your
own on your own machine, with no service or secrets involved.
