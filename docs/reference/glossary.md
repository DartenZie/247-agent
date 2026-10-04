# Glossary

The words the documentation uses, each with one meaning.

| Term | Meaning |
|---|---|
| **daemon** | The always-on process, `247-agent-core`. It reads the configuration, runs tasks, supervises connectors and answers the CLI. |
| **`oa`** | The command-line tool. It validates configuration, starts tasks by hand, injects events and inspects runs, events, connectors and cost. |
| **task** | One unit of automation: a trigger, an action and the routing of the result. Tasks live in YAML files. |
| **trigger** | What starts a task: a cron schedule, an event type, or nothing but `oa run`. |
| **action** | What a task does when it runs: `shell`, `connector`, `wait`, `sequence`, `llm`, `decide` or `agent`. |
| **run** | One execution of a task for one event. Every run is stored with its input, result, cost and status. |
| **attempt** | One try within a run. A task's retry policy gives a run several attempts; the run stays the same. |
| **event** | The only thing that flows through the system: a typed, timestamped record with a payload. Connectors and tasks publish events; triggers match them. |
| **event type** | The dotted name of an event, such as `email.received` or `task.publish_site.succeeded`. |
| **payload** | The data an event carries. Tasks read it as `${event.payload…}`. |
| **correlation id** | An id shared by every event and run that stem from one real-world happening, such as one email. It is what an approval reply is matched on. |
| **dedup key** | A string that makes an event idempotent: a second event with the same key is dropped. |
| **filter** | A JMESPath expression on a trigger that decides, cheaply and without a model, whether an event is relevant. |
| **template** | A `${…}` placeholder in configuration, replaced at run time with a value from the event, the result, state or a secret. |
| **routing** | The `emit` rules of a task: which events its result becomes. |
| **state** | A small key-value store inside the daemon, for cursors and other things a task or connector needs to remember between runs. |
| **connector** | A separate program the daemon runs to talk to the outside world: a mailbox, a chat, GitHub. It emits events, exposes operations, or both. |
| **op** | An operation a connector exposes, such as `fetch_new` or `send`. A `connector` action calls one. |
| **manifest** | The YAML file that declares a connector: what to run, what it emits, which ops the daemon may call, its configuration. |
| **poller** | A built-in connector that calls an op on a schedule and turns new items into events, with no code. |
| **secret** | A credential referenced by name in configuration and resolved at run time from a backend. Its value never appears in configuration, logs or events. |
| **provider** | A named model API account in `agent.yaml`: Anthropic, OpenAI or OpenRouter. |
| **model tier** | How much intelligence a step buys: no model, a classification-only model (`decide`), one model call (`llm`), or an agent loop (`agent`). |
| **budget** | The most a run may spend on models, in dollars. There is also a daily cap for the whole daemon. |
| **ledger** | The record of every model call and what it cost. `oa cost` reads it. |
| **agent program** | A program that speaks the Agent Client Protocol (ACP), such as Claude Code or Codex. An `agent` action opens a session on it. |
| **workspace** | The fresh directory an agent works in for one run: a git worktree of a repository, or a temporary directory. |
| **gate** | A deterministic command that runs after an agent reports success, such as a build. A failing gate fails the run. |
| **RESULT.json** | The file an agent must leave in its workspace, saying whether it is `done` or `blocked` and why. |
| **blocked** | An agent's way of saying it could not do the task, with what is missing. The run still succeeds, so the answer can be routed. |
| **sandbox** | Bubblewrap confinement for a shell step or an agent program: a read-only system, one writable directory, the daemon's files hidden. |
| **network allowlist** | The hosts a sandboxed agent program may reach. Everything else is refused. |
| **reload** | Re-reading all configuration without restarting the daemon: `oa reload` or `systemctl reload 247-agent`. |
| **retention** | How long events, runs, ledger rows and workspaces are kept before the daemon deletes them. |
| **transcript** | The stored record of an agent session: the prompt, what the agent said, every tool call and permission decision, the result. |
