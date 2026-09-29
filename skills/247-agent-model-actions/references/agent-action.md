# `agent` action

One session on an ACP agent (Agent Client Protocol) in a fresh workspace, under a policy,
a tool-call cap and a budget, ending in a RESULT.json that routing reads.
`docs/ARCHITECTURE.md` §5.4, §6, §11, §13.

## Fields

| field | meaning |
|---|---|
| `connector` | a `transport: acp` connector (`connectors.d/claude.yaml`); default `defaults.agent.connector` |
| `model` | optional; prices the reported tokens when the agent reports no cost. The agent program picks its own model |
| `max_tool_calls` | tool calls allowed in one run; past it the session is cancelled and the run fails. Default `defaults.agent.max_tool_calls` (40) |
| `budget` | `{ max_usd }`; the smaller of this and the task's applies. The session is cancelled when the agent's reported cost passes it |
| `workspace` | `{ kind: git-worktree, repo, branch }` (a worktree on branch `agent/<run_id>`) or `{ kind: temp }`; at `<defaults.agent.work_dir>/<run_id>`, `${run.workspace}` |
| `tools` | ACP tool kinds the agent may use: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`. Required |
| `bash_allow` | what an `execute` call may run: the command must equal an entry, or be a linear chain (`&&`, `\|\|`, `\|`, `;`, `&`) whose every segment equals an entry or starts with one followed by a space, with no redirection, substitution or line break (`<`, `>`, backticks, `$(`, `${`) anywhere. A chain operator inside quotes or backslash-escaped is an argument, not a chain (`grep -E "a\|b" x` passes under `grep`); an unterminated quote is refused |
| `unasked_execute` | `judge` (default): an `execute` call the agent ran without asking is held to `bash_allow` after the fact. `sandboxed`: only its kind and paths are judged, because the agent's own OS sandbox confined it (Codex). Calls that ask are always judged in full |
| `mcp_servers` | connector ops as agent tools: not implemented yet, must be `[]` |
| `system_file` | static text prepended to the prompt (ACP has no separate system channel); relative to agent.yaml |
| `prompt` | templated; the task |
| `result` | `{ path: RESULT.json, schema: schemas/x.json }`, both optional; `path` is relative to the workspace |
| `post` | ordered gates after `status: done`: `- shell: [argv]`, optional `env`, optional `when` (JMESPath over `{event, result, state, env, run}`) |

## Scoping an agent

Scope is what limits damage, so make it explicit and small:

- Name the files the agent may touch in the prompt, and say "and nothing else".
- `tools` without `edit` when only reading is expected; without `execute` when no
  command is needed. `delete` and `move` only when the task really needs them.
- `bash_allow` lists whole commands (`"npm run build"`), not binaries; `"git"` would
  allow `git push`. Arguments may follow an entry, and a chain passes only when every
  segment is allowed on its own: `git status && npm run build` needs both entries,
  `npm run build && curl …` is refused, and so is any redirection, substitution or
  quoted operator (the core does not parse shell). List the read-only commands the
  agent runs on its own as well (`git status`, `git diff` for `diff_stat`): Claude Code
  does not ask for those, and the after-the-fact check fails the run when they are
  missing.
- `unasked_execute: sandboxed` only for an agent with a real OS sandbox that asks before
  every escape, i.e. Codex on `connectors.d/codex.yaml` (`approval_policy: on-request`).
  Codex runs reads, `sed`, `rg`, chained with `&&`, and edits and builds inside the
  worktree, without asking, and no allowlist can enumerate them; its workspace-write
  sandbox is what confines them (codex-acp 1.12.0 pins that sandbox whatever
  `sandbox_mode` says). Network and writes outside the worktree are denied by the sandbox
  and ask, and are then judged against `tools`/`bash_allow`. Never pair it with
  `approval_policy: never` or `danger-full-access`.
- Untrusted input in a delimited block; the `system_file` says it is data.
- `max_tool_calls` and `budget` sized to the task: a YAML edit is 20 calls and cents, a
  site-wide change is 60 calls and a few dollars, and it gets an approval gate.

Every permission request is judged per call (never `allow_always`): tool kind in
`tools`, `execute` command in `bash_allow`, paths inside the workspace. Refusals are
logged as `agent.permission` with a reason. A tool call the agent ran *without* asking
(Claude Code does that for reads and `git status`-like commands; Codex for every command
its own sandbox admits, asking only to escape it) is judged after the fact from what the
agent reported, in full under `unasked_execute: judge` and on kind and paths only under
`sandboxed`; a violation cancels the session and fails the run
(`agent.policy_violation`). That catches a step outside the policy, it does not prevent
it, so pick agents and modes that ask, and sandbox the program itself: `sandbox: bwrap`
on the connector's manifest (`connectors.d/claude.yaml`, the `247-agent-connectors`
skill) keeps it away from the daemon's socket, database, config and other processes, with
`work_dir` and the repositories listed in `ro_binds` as all it can touch. Every
`workspace.repo` an agent task uses must be in those binds, or `oa validate` refuses the
task.

## RESULT.json contract

The runner appends the contract to every prompt, so the agent is told, not assumed to
know. The file (`result.path`, default `RESULT.json`, at the workspace root) is a JSON
object with at least:

- `status`: `"done"` (the change is in the workspace) or `"blocked"` (it could not be
  done: missing information, out of scope, refused);
- `summary`: one or two sentences for a human.

`result.schema` adds the task's own fields (`files_changed`, `diff_stat`, `missing`, …)
and is validated on top. The run result is the document itself, so `emit` and `post`
read `${result.summary}`, `${result.missing}`.

- `done` → the `post` gates run in order; a failing gate fails the run.
- `blocked` → gates skipped, the run **succeeds**. Route it:

```yaml
emit:
  - type: site.change_blocked
    when: "result.status == 'blocked'"
    payload: { summary: ${result.summary}, missing: ${result.missing}, email: ${event.payload.email} }
```

and a deterministic task on `site.change_blocked` replies to the sender (`email.send`),
asks in chat, or files a ticket. Missing file → one nudge turn in the same session; still
missing or invalid → the run fails, `retry` repeats it in a fresh workspace, and
`task.<name>.failed` reaches `notify`.

## Post gates

Run in order in the workspace after a `done` result, through the `shell` runner (so
`defaults.sandbox` applies). Typical sequence: build, test, `git commit -am "…:
${result.summary}"`. A non-zero exit fails the run; nothing leaves the workspace.
Publishing is a separate task on `task.<name>.succeeded`, which is the only place a
deploy secret lives.

## Money

`ctx.llm.checkBudget` refuses before the turn (daily cap, run already over its cap).
During the turn the agent's `usage_update.cost` is watched and the session cancelled past
the cap. After every turn `ctx.llm.record` writes one ledger row: `provider` = the
connector name, cost as reported (`priced_by: provider`) or tokens at the table price of
`model` (`priced_by: table`). A turn that reports neither fails the run. `oa cost --by
provider` shows the agent's spend next to the direct model calls.

## Runner notes (`packages/core/src/actions/agent.ts`)

- `ctx.agents` (`AgentClients`, implemented by the supervisor) opens the session;
  `connectors/acp.ts` is the only file that imports `@agentclientprotocol/sdk`.
- `agent-policy.ts` (`decidePermission`) is pure; `agent-workspace.ts` creates and removes
  workspaces; `agent-result.ts` reads and validates RESULT.json (zod's `fromJSONSchema`
  for `result.schema`).
- The turn is an async iterator of normalised updates (`connectors/acp-types.ts`); the
  runner counts `tool_call`s, watches `usage`, cancels on the run's signal, and rethrows
  the executor's timeout/stop reason.
- The workspace is kept on success (both statuses) and removed with its branch on failure.
- Tests use `packages/core/test/fixtures/fake-acp.ts`, a real ACP agent process scripted
  by markers in the prompt (`[[run: …]]`, `[[edit: …]]`, `[[result: {…}]]`, `[[cost: …]]`,
  `[[tools: N]]`, `[[slow: ms]]`, `[[refuse]]`, `[[crash]]`), never a model.
