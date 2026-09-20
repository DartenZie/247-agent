# 247-agent

A small, always-on automation daemon for a Linux server. You describe *what should
happen when* in a YAML file; the daemon runs it around the clock and calls an LLM only
where judgement is actually needed.

It exists because "everything goes through the model" agents are expensive. Here,
polling a mailbox, filtering by sender, deduplicating, retrying and publishing over FTP
are plain code. A model is called once to classify, and an agent loop runs only for the
edit that needs it, with the model tier, turn count and dollar budget you chose.

## How it works

```
connector ──event──▶ trigger ──▶ task ──result──▶ more events ──▶ ...
```

- **Connectors** are sub-programs (email, chat, GitHub, Jira, …) that push events into
  the core and expose operations as MCP tools. Any language; existing MCP servers work.
- **Triggers** are cron schedules or event matches with a cheap filter expression.
- **Tasks** run one action and route the result as new events. Action kinds:

  | kind | what | model? |
  |---|---|---|
  | `shell` | run a command | no |
  | `connector` | call one operation on a sub-program | no |
  | `llm` | one model call with a JSON schema (classify, extract) | one call |
  | `agent` | agentic loop in a sandboxed git worktree with tool allowlists | loop, budgeted |
  | `wait` | pause until an event arrives (human approval) | no |
  | `sequence` | a few of the above in one run | depends |

State, events, run history and per-run cost live in SQLite. The daemon runs under
systemd; a CLI (`oa`) validates config, triggers tasks by hand and tails events.

## Example

Maintaining a website from a trusted sender's emails:

1. Every two minutes, fetch new mail (no model).
2. Mail from the trusted sender's address triggers a one-shot Haiku classification:
   event-list update, general change, or ignore.
3. An event-list update runs a small, tightly scoped agent on Sonnet.
4. A general change runs a larger agent on Opus, then asks you on chat before pushing.
5. A successful update triggers an FTP mirror (no model), and a chat notification.

The full config is in [`docs/examples/website-updates.yaml`](docs/examples/website-updates.yaml).

## Status

The non-LLM path works end to end: triggers, `shell`, `connector`, `wait` and `sequence`
actions, routing, state, secrets, retries, the connector supervisor and the `oa` CLI.
The email connector (IMAP/POP3 in, SMTP out) is in. The `llm` and `agent` actions, the
cost ledger and the chat connector are next.
Read [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) to install, configure and operate it,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design, and
[`CLAUDE.md`](CLAUDE.md) for the conventions the codebase follows.

## Planned stack

TypeScript on Node.js 22, SQLite, MCP for connector operations, the Anthropic SDK for
single model calls and the Claude Agent SDK for agent loops. See the architecture doc
for why these and not an off-the-shelf workflow engine.

## Roadmap

1. Core: config, event store, scheduler, matcher, executor, `shell` action, CLI.
2. Connector supervisor, built-in poller, email connector.
3. `llm` action with structured outputs, cost ledger and budgets.
4. `agent` action on the Claude Agent SDK with worktrees and post-run gates.
5. `wait` action and chat connector for approvals.
6. Hardening: retention, metrics, sandboxing, hot reload.

## License

[WTFPL](LICENSE)
