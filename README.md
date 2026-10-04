# 247-agent

A small, always-on automation daemon for a Linux server. You describe *what should
happen when* in YAML; the daemon runs it around the clock and calls a language model
only where judgement is actually needed, with a budget you set.

It exists because "everything goes through the model" agents are expensive and hard to
trust. Here, polling a mailbox, filtering by sender, deduplicating, retrying and
publishing over SFTP are plain code. A model is called once to classify, and an agent
loop runs only for the edit that needs it, in a sandboxed worktree, with the model
tier, command allowlist and dollar cap you chose.

```
connector ──event──▶ trigger ──▶ task ──result──▶ more events ──▶ more tasks
```

- **Connectors** are sub-programs that push events into the daemon and expose
  operations as MCP tools: email, SFTP/FTP, Telegram and Matrix, webhooks, GitHub,
  Jira. Any existing MCP server works as one; any ACP agent program (Claude Code,
  Codex) is one too.
- **Triggers** are cron schedules or event matches with a cheap filter.
- **Tasks** run one action and route the result as new events:

  | kind | what | model? |
  |---|---|---|
  | `shell` | run a command | no |
  | `connector` | call one operation on a connector | no |
  | `wait` | pause until an event arrives, such as a human's approval | no |
  | `sequence` | a few of the above in one run | no |
  | `decide` | typed questions to a classification-only model, probabilities back | one call, very cheap |
  | `llm` | one model call with a JSON schema: classify, extract, summarise | one call |
  | `agent` | an agent session in a sandboxed git worktree with tool and command allowlists | a budgeted loop |

Events, runs, state and every model call's cost live in SQLite. The daemon runs under
systemd; the `oa` CLI validates configuration, starts tasks by hand, injects events and
shows you what happened.

## Example

A website maintained from a trusted editor's emails, the reference workflow in
[`docs/examples/website-updates.yaml`](docs/examples/website-updates.yaml):

1. Every two minutes, fetch new mail. No model.
2. Mail from the editor's address gets one short classification call: events-list
   update, general change, or ignore.
3. An events-list update runs a small, tightly scoped agent on a mid-tier model.
4. A general change runs a larger agent on the top model, then asks you on chat.
5. A successful update is mirrored over SFTP. No model.
6. Every failure, and every publish, is reported on chat.

## Install

On Debian, Ubuntu or Fedora, the package from the
[latest release](https://github.com/DartenZie/247-agent/releases/latest):

```sh
sudo apt install ./247-agent_<version>-1_amd64.deb     # or: sudo dnf install ./247-agent-<version>-1.x86_64.rpm
```

On any other Linux, the installer script, which downloads the release tarball and sets
up the user, `/etc/247-agent` and the systemd unit:

```sh
curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh
```

Then `sudo oa run hello --wait` runs the starter task. Every release is self-contained:
bundled programs, a pinned Node.js, the SQLite addon, the docs, the examples and the
agent skills. Nothing else has to be installed.

## Documentation

- [User guide](docs/index.md): install, your first task, every action and connector,
  recipes, production operations, the reference tables.
- [Internal docs](docs/internal/README.md): architecture, design decisions, the
  contracts each module keeps, how to add a connector or an action, how a change is
  verified. Start at [`CLAUDE.md`](CLAUDE.md) if you are an agent working on the code.
- [Agent skills](skills/README.md): skills that ship with every release so an agent
  can write tasks, configure connectors and operate the daemon it runs under.

## Development

Node.js 22, npm workspaces, TypeScript.

```sh
npm install
npm run build
npm test
npm run lint
node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml
```

The launchers in `bin/` work the same in a checkout and in an installed release.
`npm run test:linux` runs the suite on Debian with bubblewrap in a container, and the
smoke rigs under `test/smoke/` exercise the real connectors and real agent programs.

## License

[WTFPL](LICENSE)
