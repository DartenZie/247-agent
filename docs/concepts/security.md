# Security

This page explains what the daemon trusts, where secrets live, and how an agent is
kept from doing harm. Read it before you give an agent a repository or a credential.

## Who is trusted

The daemon and the connectors it starts all run as one unprivileged system user,
`247-agent`. Anything running as that user is trusted: it can reach the daemon's socket
and read the other processes' environments. That is fine for the daemon's own code and
for connectors you installed. It is not fine for anything that executes content the
daemon did not write: an agent working from an email, or a build of what that agent
produced. Those run inside a **sandbox** that hides the socket, the database, the
configuration and the other processes.

## Secrets

Configuration never contains a credential. It contains a name:

```yaml
env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
```

The value comes from a **secrets backend** at run time: an environment variable, a
file readable only by the service user, or a systemd credential. The daemon resolves
only the names a run actually uses, hands them to that one action or connector, and
never writes them to the database, a log line, an event or an agent transcript.

Three rules follow from that:

- A connector receives only the secrets its manifest names, once, when it starts.
- A model provider's key is used inside the daemon for that one call.
- An agent never receives a deploy credential. The agent program's own model key is
  in its manifest, nowhere else. Publishing is a separate task, the only one that holds
  the SFTP password or the push token.

## Untrusted content

Emails, chat messages, webhook bodies and ticket text come from outside. They enter a
prompt as data inside a delimited block, and the system prompt says so. But the real
protection is not the prompt. It is the capability surface: what the agent is allowed
to do at all.

## How an agent is confined

An `agent` action is confined on four levels. Use all of them.

1. **A fresh workspace per run.** A git worktree on its own branch, or an empty
   temporary directory. The agent never edits your base checkout. The workspace is
   kept when the run succeeds, for the gates and for inspection, and removed when it
   fails.
2. **An explicit allowlist.** `tools` names the kinds of tool the agent may use, such
   as reading, editing and executing. `bash_allow` lists the exact commands it may run.
   Every permission request the agent makes is judged against these, per call, never
   granted "always". Paths must stay inside the workspace. A tool the agent used
   without asking is judged after the fact, and a violation cancels the session and
   fails the run, so a result produced outside the policy never routes anywhere.
3. **A sandbox around the program.** The agent program itself runs in bubblewrap when
   its manifest says so: the operating system and the install read-only, one writable
   directory for workspaces, the repositories you list, and nothing of the daemon's.
   With a **network allowlist** it can reach only the hosts you name, through a
   filtering proxy; a request anywhere else is refused and logged, which is also how
   you learn what an agent wanted.
4. **Deterministic gates and a human.** After the agent reports `done`, the gates run:
   a build, the tests, a commit. A failing gate fails the run. For anything
   high-impact, a `wait` for your approval on chat sits between the agent and the task
   that publishes.

Hard limits back all of this: a cap on tool calls, a dollar budget, and a wall-clock
timeout, each of which cancels the session.

## Shell steps that run untrusted code

A `shell` action that builds or tests what an agent produced is running untrusted
code. Give it `sandbox: bwrap`, or set `defaults.sandbox: bwrap` in `agent.yaml` and
opt out only for the publishing step, which needs the network and its secret.

## A connector with more privileges

A connector that must bind a port below 1024, read another user's files or hold a
credential the daemon should not see runs in its own systemd unit, with its own user
and its own credentials. The daemon talks to it over a socket and never resolves its
secrets. See [A connector in its own unit](../connectors/own-unit.md).

## Checklist before going live

- Every credential is a `${secrets.<name>}` reference. `grep` your config for anything
  that looks like a key.
- Every `agent` task has `tools` and `bash_allow` as small as they can be, a budget, a
  tool-call cap and a timeout.
- The agent program's manifest has `sandbox: bwrap` with `network.allow` listing the
  model API and the package registry, and every repository the tasks use in
  `ro_binds`.
- Publishing is its own task, triggered by success, and the only holder of the deploy
  secret.
- A task listens on `task.*.failed` and `budget.exceeded` and tells you.

Next: [Tasks](../tasks/index.md) to start writing, or
[Production](../operations/production.md) for the systemd setup.
