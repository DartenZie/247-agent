# ACP smoke rig

An end-to-end run of the `agent` action against a real ACP agent: the daemon, one pinned
agent program and four scripted tasks. It is not part of `npm test` (which never touches a
model); run it by hand when you change the ACP client, the agent runner, the tool bridge or
the transcript, or when you bump an adapter. There is no default agent: name the one to
test, and you need only that agent's login.

```
npm run build
npm run smoke:acp -- claude-acp     # Claude Code, your Claude login (CLAUDE_CONFIG_DIR or ~/.claude)
npm run smoke:acp -- codex-acp      # Codex, your ChatGPT login (CODEX_HOME or ~/.codex)
npm run smoke:acp -- opencode-acp   # OpenCode on free Zen models: no login at all
```

| agent          | program                                    | tasks run on                 | smoke_override         |
| -------------- | ------------------------------------------ | ---------------------------- | ---------------------- |
| `claude-acp`   | `@agentclientprotocol/claude-agent-acp@0.80.0` | `claude-haiku-4-5`           | `claude-sonnet-5`, low |
| `codex-acp`    | `@agentclientprotocol/codex-acp@1.12.0`    | `gpt-5.6-luna`, low effort   | `gpt-5.6-terra`, medium |
| `opencode-acp` | `opencode-ai@1.18.34 acp`                  | `opencode/big-pickle` (free) | `opencode/ling-3.1-flash-free`, medium |

Claude and Codex run on your subscription, not an API key, so a run costs nothing on top
of your plan; OpenCode's models are free. A connector inherits only a minimal environment
(`PATH`, `HOME`, …) plus its manifest's `env`, so no API key in your shell reaches the agent.

Each agent is a profile in `agents/<name>.yaml`: its login, its connector manifest, the
fields set on every task (`model`, `unasked_execute`), the model and effort of
`smoke_override`, and pricing for models the built-in table lacks. `run.mjs` builds the
daemon config from `agent.base.yaml`, `tasks.yaml`, `probe.yaml` and the profile into
`.state/<name>/`, validates it, recreates `.state/repo` from `repo/` (a sorted word list
and its `npm run check`), starts the daemon, waits for the agent and `probe` connectors,
then runs:

| task             | checks                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `smoke_done`     | `status: done`, `items.txt` changed, the post gates committed on `agent/<run_id>`           |
| `smoke_blocked`  | `status: blocked` with a non-empty `missing` (the request names no word)                    |
| `smoke_mcp`      | the agent called `probe.stamp` through `mcp_servers` (`agent.mcp_call`) and returned the stamp |
| `smoke_override` | the profile's model and effort show up in the `agent.config` log line; the other runs kept theirs |

Then it scans `oa runs logs` and `oa runs show` of every run, the events and the daemon
log for a canary secret (`OA_SECRET_SMOKE_CANARY`, fresh per run, handed to the agent in the
`smoke_mcp` prompt) and for anything shaped like an API key; the `smoke_mcp` transcript
must show it as `[secret:smoke_canary]`. Last it prints `oa cost` by provider (the agent)
and by model, and stops the daemon. Exit 0: every check passed; 1: a check failed; 2: the
rig did not start (bad argument, missing build or login, or a login that no longer works).

Caps: $0.50 per run (`defaults.agent.budget`) and $3 per day (`budgets.daily_usd`), for
the notional price the ledger puts on each turn. The database in `.state/` (gitignored) is
shared by every agent and kept between runs, so the daily cap and `oa cost` count every
smoke run of the day; delete `.state/` to start over. The daemon log of the last run is
`.state/daemon.log`, the generated config `.state/<name>/`.

Adding an agent: a new `agents/<name>.yaml`. Find its model and effort option values by
opening a session (`session/new` returns `configOptions`), and check which tool kinds it
reports (the `agent.tool_call` lines of the daemon log) against the tasks' `tools`.

Known quirks, found by this rig:

- codex-acp reports MCP tools as kind `execute` (claude-agent-acp: `other`), and reads
  your `~/.codex/config.toml`: its MCP servers load into the session, and
  `approvals_reviewer = "guardian_subagent"` reviews the MCP call itself (a `think` call)
  instead of asking the core; 1.12.0 ignores an override from `-c` or `CODEX_CONFIG`.
- OpenCode sometimes reports a shell call `in_progress` before it asks permission for it;
  the core then treats a command outside `bash_allow` as run without asking and cancels
  the session instead of refusing the one call, so `smoke_done` can fail on it.
- Free OpenCode models come and go; when one is gone, pick another with
  `opencode models opencode` and keep a $0 pricing entry for it.
