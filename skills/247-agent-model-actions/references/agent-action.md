# `agent` action

An agentic loop with tools in a sandboxed worktree. `docs/ARCHITECTURE.md` §5.4, §11, §13.

## Fields

| field | meaning |
|---|---|
| `runtime` | `claude-agent-sdk` (in-process `query()`), `claude-cli` (`claude -p … --output-format json`), `managed-agents` (hosted sandbox, diff back). Same config, swappable |
| `model`, `effort`, `max_turns` | tiering; defaults from `defaults.agent` |
| `budget` | `{ max_usd }` hard stop; run → `failed`, `on_failure` fires |
| `workspace` | `{ kind: git-worktree, repo, branch }`; a fresh worktree under `work/<run_id>/`, discarded on failure, GC'd by `retention.workspaces` |
| `tools` | allowlist of SDK tools: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash` |
| `bash_allow` | exact command prefixes Bash may run; anything else is denied by a `PreToolUse` hook |
| `mcp_servers` | connector names exposed as MCP tools (same server the core talks to; the manifest's `ops` allowlist still applies) |
| `system_file`, `prompt` | static system prompt file; templated task prompt |
| `result` | `{ from: file, path: RESULT.json, schema: schemas/x.json }` |
| `post` | ordered deterministic gates run in the worktree: `- shell: [argv]`, templated over `result` |

## Scoping an agent

Scope is what limits damage, so make it explicit and small:

- Name the files the agent may touch in the prompt, and say "and nothing else".
- `tools` without `Write` when only edits are expected; without `Bash` when no command
  is needed.
- `bash_allow` lists whole commands (`"npm run build"`), not binaries.
- No connector in `mcp_servers` unless the task needs it, and then one whose manifest
  `ops` excludes anything that sends or publishes.
- Untrusted input in a delimited block; the system prompt says it is data.
- `max_turns` and `budget` sized to the task: a YAML edit is 20 turns and cents, a
  site-wide change is 60 turns and a few dollars, and it gets an approval gate.

## RESULT.json contract

The prompt tells the agent to write `RESULT.json` at the worktree root with the fields
the schema requires (typically `summary`, `files_changed`, optionally `diff_stat`). The
runner validates it against `result.schema`; missing or invalid means the run failed.
Downstream `emit` rules read `${result.summary}` etc.

## Post gates

Run in order in the worktree after the agent finishes and the result validates. Typical
sequence: build (`npm run build`), test, `git commit -am "…: ${result.summary}"`. A
non-zero exit fails the run; nothing leaves the worktree. Publishing is a separate task
on `task.<name>.succeeded`, which is the only place a deploy secret lives.

## Retry

On retry the runner starts a fresh worktree and appends the previous failure to the
prompt once. `timeout` is wall-clock per attempt, plus `max_turns`.

## Runner notes (for implementing `packages/core/src/actions/agent.ts`)

- `query()` from `@anthropic-ai/claude-agent-sdk` with `cwd` = worktree,
  `allowedTools`, `maxTurns`, `mcpServers`, `permissionMode`, and a `PreToolUse` hook
  that enforces `bash_allow` and logs every tool call to the run.
- Record usage per turn into the ledger; stop when `budget.max_usd` is reached.
- Persist the transcript with the run.
- The worktree is created from `workspace.repo`/`branch` before the loop and removed on
  failure; on success it is kept for `post` gates and for `${run.workspace}` in `emit`.
- Optional sandbox wrapper (`bwrap`/`firejail`) and network allowlist are planned; keep
  the seam.
- Tests use a fake runtime, never a real model.
