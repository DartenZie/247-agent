# Agent programs

An [`agent`](../tasks/agent.md) task opens a session on an agent program: Claude Code,
Codex, or any other program that speaks the Agent Client Protocol (ACP). The program is
declared as a connector with `transport: acp`. This page is about the connector side: the
manifest, the model key, the sandbox around the program, and the network allowlist. The
task side (what the agent may do, its budget, its result) is on the agent action page.

## Claude Code

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

Line by line:

- `exec` runs the ACP adapter for Claude Code through `npx`, which fetches it from the
  npm registry on first use. The daemon puts its own Node first on `PATH`, so this is the
  bundled `npx`.
- `transport: acp` makes it an agent program: the daemon is the client and opens one
  session per run. It serves no ops and emits no events, so `ops` and `emits` stay empty,
  and it takes no `config`: the program is configured through `env` alone.
- `env` carries the model key. The agent runs the model with its own key; the daemon
  never talks to a model provider for an agent task, and tasks never see this key. A
  claude.ai login works instead of an API key, with the caveat under the network
  allowlist below.
- `sandbox` runs the program in bubblewrap for its whole life, and `network` leaves it
  one way out. Both are explained below.

Tasks name it with `connector: claude`, or `defaults.agent.connector: claude` in
`agent.yaml` names it for every agent task.

## Codex

```yaml
name: codex
exec: ["npx", "-y", "@agentclientprotocol/codex-acp"]
transport: acp
env:
  OPENAI_API_KEY: "${secrets.openai_api_key}"
  CODEX_CONFIG: '{"model":"gpt-5.6-sol","approval_policy":"on-request","model_reasoning_effort":"medium"}'
restart: { base: 1s, max: 60s }
```

`CODEX_CONFIG` is JSON merged into every session's Codex configuration: the model, the
reasoning effort, the approval policy. A task's `model:` and `effort:` override the first
two per session. Three things are specific to Codex:

- **Keep `approval_policy: on-request`.** Codex has its own operating-system sandbox and
  asks only before a command that must escape it (network, writes outside the
  workspace). The daemon's permission policy judges what the agent asks; `never` or
  `danger-full-access` would take those questions away.
- **Set `unasked_execute: sandboxed` on the task.** Codex runs reads, edits and builds
  inside the workspace without asking, and no command allowlist can enumerate them; its
  sandbox is what confines them. The task side of this is on the
  [agent action page](../tasks/agent.md).
- **Price the model.** Codex reports tokens but no cost, so the task names `model:` and
  `agent.yaml` needs a `pricing:` entry for a model the built-in table does not know.

Codex's sandbox confines what the agent runs, not the program itself, which still runs as
the daemon's user. Add `sandbox: bwrap` as for Claude to change that.

## Other agent programs

Any program that speaks ACP version 1 over stdio works: `gemini --experimental-acp`,
`opencode acp`, and the list at agentclientprotocol.com. The task's `tools` and
`bash_allow` policy answers the program's permission requests, so prefer programs that
ask before acting. To find a program's model and effort option values, open a session
once and read the options it offers; a wrong value fails the run with the offered values
in the error.

## The sandbox

The agent program is the one process on the server that executes content the daemon did
not write. `sandbox: bwrap` runs it in bubblewrap for its whole life:

- The operating system and the 247-agent install are read-only.
- `defaults.agent.work_dir` (by default `work/` next to the database) is the only
  writable path. It holds every run's workspace and the program's own home,
  `<work_dir>/home/<name>`, where `npx` and Claude Code keep their caches.
- The repositories you list in `ro_binds` are visible read-only. List every repository
  the tasks' `git-worktree` workspaces come from; `oa validate` refuses a task whose
  repository the sandbox cannot see. Use `rw_binds` only when the agent itself must
  commit; the reference workflow commits in a `post` gate instead, so read-only is enough.
- The daemon's socket, database, configuration directory and secrets file are
  unreachable, other processes are invisible, and the environment holds only `PATH`,
  `HOME`, the manifest's `env` and the connector's name.

`sandbox` takes the same forms as on a [`shell`](../tasks/shell.md) action (`bwrap`, or
`{ backend: bwrap, ro_binds, rw_binds, extra_args }`) plus `network`. Only an agent
program can be sandboxed: every other connector needs the daemon's socket, which the
sandbox hides. `oa connector list` shows `sandbox=bwrap`.

It needs the `bubblewrap` package on the server and unprivileged user namespaces, which
the production page covers; without `bwrap` the spawn fails and the connector stays down
with the error in `oa connector list`. Because the process is shared by concurrent runs,
the sandbox is per program, not per run: an agent can see other runs' workspaces under
`work_dir`.

> [!WARNING]
> `oa validate` refuses a bind or a `work_dir` that would show the sandbox the database,
> the socket, `agent.yaml` or the secrets file. Keep `work_dir` under the state
> directory, where the shipped unit already allows writes.

## The network allowlist

Without `network`, the sandbox shares the host's network: the program needs its model API.
`network: { allow: [...] }` takes that away and leaves one way out, a filtering proxy the
daemon runs for this sandbox, to the listed targets only. An entry is `host[:port]`:

| Entry | Lets through |
|---|---|
| `api.anthropic.com` | that host, port 443 (the default) |
| `*.npmjs.org` | every name below `npmjs.org` (not `npmjs.org` itself), port 443 |
| `mirror.example.com:80` | that host on that port; plain HTTP needs its port named |
| `gitea.internal:*` | that host on any port |
| `10.0.0.5:8080`, `[fd00::5]:8080` | an address |

Everything else is answered with a 403 and logged as `sandbox.net_denied` with the
connector, host and port. That log line is how you find out what an agent wants: start
with the model API and the package registry, run a task, and add what the log shows you
agree with. `allow: []` means no network at all. A changed list takes effect on
`oa reload`, which respawns the agent; `oa connector list` shows `net=allowlist` or
`net=none`.

What Claude Code needs: `api.anthropic.com`; started with `npx`, also
`registry.npmjs.org`; logged in with a claude.ai account instead of an API key, also
`platform.claude.com`.

What to know before relying on it:

- The proxy sees host and port, never the content: HTTPS stays encrypted end to end. An
  allowed host that takes uploads (a paste site, a storage bucket, the model API with
  someone else's key) is still a way out, so list hosts, not whole clouds.
- A wildcard entry never reaches a loopback, private or link-local address, whatever the
  name resolves to. An entry that names the host or the address itself does. To let the
  agent reach a service on the daemon's own machine, name it (`build-cache.internal:8080`).
- A sandbox holds at most 256 connections open through its proxy; one more is closed
  unanswered and logged as `sandbox.net_dropped`.
- Only programs that honour `HTTPS_PROXY` and `HTTP_PROXY` get out: Claude Code, Node,
  npm, curl and git over HTTPS do; git over SSH and raw sockets do not. The sandbox sets
  those variables for the agent, over the manifest's `env`.
- `localhost` inside the sandbox is the sandbox's own; nothing on it reaches the proxy.

> [!TIP]
> A forgotten registry shows up as a connector that stays `down` with npm `E403` in its
> `connector.output` lines. Add `registry.npmjs.org` and `oa reload`.

## Lifecycle

An agent program has the same lifecycle as any connector: it is started with the daemon,
restarted with backoff when it exits, respawned by `oa reload` when its manifest changed
and by `oa connector restart <name>` after a rotated key, and its standard error is
logged as `connector.output`. A changed `work_dir` in `agent.yaml` also respawns every
sandboxed agent, since it mounts the old one. `oa connector list` shows `acp` as its
transport.
