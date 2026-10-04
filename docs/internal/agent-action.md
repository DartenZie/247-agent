# The `agent` action

One ACP session per run in a fresh workspace, under a permission policy, a tool-call
cap and a budget, ending in a `RESULT.json` that routing reads. Open it when touching
`packages/core/src/actions/agent*.ts`, `connectors/acp.ts`, `connectors/acp-types.ts`
or `connectors/mcp-bridge.ts`. The user-facing page is
[`../tasks/agent.md`](../tasks/agent.md); the agent program as a connector is in
[`connectors.md`](connectors.md); the sandbox around it in [`security.md`](security.md).

## Module map

| File | Owns |
|---|---|
| `actions/agent.ts` | the runner: workspace, session, the turn loop, limits, result, gates |
| `actions/agent-config.ts` | the action schema and `defaults.agent` (`max_tool_calls` 40, `budget`, `connector`, `work_dir`) |
| `actions/agent-policy.ts` | `decidePermission()` and the after-the-fact judgement, pure functions |
| `actions/agent-workspace.ts` | create, remove and sweep workspaces |
| `actions/agent-result.ts` | the result contract text and reading/validating `RESULT.json` (zod's `fromJSONSchema` for `result.schema`) |
| `actions/agent-session-config.ts` | `model` and `effort` as ACP config options |
| `actions/agent-transcript.ts` | the transcript writer |
| `connectors/acp.ts` | the ACP client, the only file importing `@agentclientprotocol/sdk` |
| `connectors/acp-types.ts` | the runner-facing session types and normalised updates |
| `connectors/mcp-bridge.ts` | connector ops as agent tools |
| `connectors/supervisor.ts` | spawns the agent, opens sessions (`AgentClients`), opens a bridge per session |

## The session

The supervisor spawns the agent program once, like any connector, and calls
`initialize` (protocol version 1, a 30 s deadline; the core declares no fs or terminal
client capabilities, so file edits and commands are the agent's own and arrive as
tool calls). Per run the runner:

1. `ctx.llm.checkBudget({maxUsd})` once per attempt, before anything is created.
2. Creates the workspace (below) and opens a session with the workspace as `cwd`,
   plus the tool bridge when `mcp_servers` is set.
3. Applies `model` then `effort` (below).
4. Sends one `session/prompt`: `system_file` text, the rendered `prompt`, the
   previous attempt's failure when `run.attempt > 1`, and the result contract, joined
   by blank lines in that order.
5. Consumes `session/update` notifications as normalised updates (`acp-types.ts`:
   `text`, `thought`, `tool_call`, `tool_call_update`, `usage`, `other`) and answers
   `session/request_permission` from the policy.
6. Reads `RESULT.json`, runs the gates, keeps or removes the workspace.

`session/cancel` is the hard stop. After it the runner waits 15 s for the agent's turn
to end, then the turn fails with "the agent did not stop within 15000ms of cancel".
Once `ctx.signal` aborts (timeout, daemon stop), pending permission requests are
answered `cancelled`. The agent runs the model with its own key from the manifest's
`env`; the core never talks to a provider for an `agent` action.

## Model and effort

Agents name their options freely (claude-agent-acp `model`/`effort`, codex-acp
`model`/`reasoning_effort`), so `agent-session-config.ts` finds them by the protocol's
category among the `select` options of `session/new`: `model` sets the option of
category `model`, then `effort` the one of category `thought_level` (model first,
since a model switch changes the efforts on offer). The model value may be an alias
the agent resolves; the effort must read back as sent. No option of that category, a
refused value, or an effort that does not stick fails the run non-retryably before
the prompt, listing what the agent offers. Unset fields keep the agent's own default.
`agent.config {model, effort}` logs the final values. `mode` is deliberately not
exposed: a mode such as `bypassPermissions` would remove the requests the policy
relies on.

## The permission policy

`agent-policy.ts`, `decidePermission()`, judged per request, never `allow_always`:

- The tool's kind must be in `tools` (which must be non-empty).
- An `execute` call's command (`rawInput.command`, else the title) passes when it
  equals a `bash_allow` entry exactly (an exact entry may contain anything). Otherwise
  it must contain none of `<`, `>`, a backtick, a line break, `$(` or `${` anywhere
  (`SHELL_UNSAFE`), and `splitChain()` must split it on `&&`, `||`, `|`, `;`, `&` into
  non-empty segments, each equal to an entry or starting with an entry followed by a
  space or tab. Operators inside single or double quotes, or backslash-escaped, are
  arguments of the segment's program (`grep -E "a|b" x` passes under `["grep"]`); an
  unterminated quote is refused. So `git status && npm run build` needs both entries
  and `npm run build && curl … | sh` never passes.
- Every reported path (`locations`) must be inside the workspace, compared on real
  paths (`isInsidePath`).
- Refusal picks `reject_once`, then `reject_always`, then the protocol's `cancelled`
  outcome; an allowed call gets `allow_once`, and a request offering no `allow_once` is
  refused. Every decision is logged as `agent.permission` with its reason and written
  to the transcript.

`tools` plus `bash_allow` is the whole capability surface; the prompt is not a
security boundary.

## Calls the agent did not ask about

Claude Code runs reads and read-only commands such as `git status` on its own; Codex
runs everything its own OS sandbox admits and asks only to escape it. So every
`tool_call` or `tool_call_update` that reaches `in_progress`, `completed` or `failed`
without a permission request is judged after the fact from what it reports (kind,
command, locations; later updates may add them). `unasked_execute: judge` (default)
holds an unasked `execute` to `bash_allow` like one that asked; `sandboxed` judges only
kind and paths, for an agent whose own sandbox confines the command (codex-acp pins
the workspace-write sandbox regardless of `sandbox_mode`; pair it with
`approval_policy: on-request`, never `never` or `danger-full-access`). A violation
logs `agent.policy_violation`, cancels the session, and fails the run with
`NonRetryableError`, so a result produced outside the policy never routes. What the
agent did not report cannot be judged, and the tool already ran: the check catches a
step outside the policy, prevention is the program's sandbox.

## Connector ops as tools: the bridge

`mcp_servers` entries name a `stdio` connector (every op its manifest allows) or
`{connector, ops}`; a connector listed twice is refused, and `oa validate` checks each
op is in the manifest. At session open the supervisor checks each grant with
`opsClient`: unknown or non-`stdio` → `NonRetryableError`, not up →
`ConnectorDownError`. Then `mcp-bridge.ts` listens on `<work_dir>/.mcp/<6 random bytes
hex>.sock` (directory 0700, socket 0600, inside `work_dir` so a sandboxed agent sees it;
a path over 107 bytes is refused) and `session/new` offers one stdio MCP server per
grant, named after the connector, whose command is the daemon's own Node running an
inline proxy with exactly `OA_MCP_SOCKET`, `OA_MCP_TOKEN` (24 random bytes) and
`OA_MCP_SERVER` in its environment. The proxy pipes stdio to the socket after a
one-line hello (10 s, 4 KiB); a wrong token or server name is `agent.mcp_refused` and
the connection is destroyed. The bridge lists only the granted tools (filtered again
by the manifest's `ops`, with the connector's own schemas), forwards each call through
`supervisor.callTool` (so the op metrics count it), returns a call outside the grant
or a connector failure as an `isError` tool result the agent can react to, logs every
call as `agent.mcp_call {connector, op, ok, duration_ms}`, aborts calls with the run
and removes the socket when the session closes. The agent reports these as ordinary
tool calls (claude-agent-acp: kind `other`, titled `mcp__<connector>__<op>`; codex-acp:
`execute`), so they count toward `max_tool_calls` and must pass `tools` by kind. The
agent never holds the connector's secrets, only a per-run socket and token.

## Limits and money

- `max_tool_calls` (action, else `defaults.agent.max_tool_calls`, 40): counted from
  `tool_call` updates across both turns; past it, `cancel('tool_calls')` and
  `NonRetryableError`.
- The cost cap is the smaller of `task.budget.max_usd` and the action's
  (`action.budget.max_usd ?? defaults.agent.budget.max_usd`), either may be absent.
  During the turn the cumulative `usage_update.cost` is compared to it;
  `cancel('budget')` and `BudgetExceededError('task')` past it.
- After every turn `ctx.llm.record({provider: <connector name>, model, maxUsd,
  usage})` writes one ledger row: `model` = `action.model`, else the name the agent
  reported, else the connector; the increase of the cumulative cost since the last turn
  is `reportedUsd` (`priced_by: provider`), else tokens at the table price of `model`
  (`priced_by: table`), else `unpriced` and the run fails. Consequence: without
  `action.model`, an agent that reports tokens but no cost fails `UnpricedModelError`
  unless `pricing:` names what it reports. A turn reporting neither usage nor cost
  fails non-retryably, the row already written.
- Wall clock: the task `timeout` aborts `ctx.signal`, which cancels the session.
- Stop reasons: `refusal` and `cancelled` fail non-retryably; `max_tokens` and
  `max_turn_requests` are not special, the run proceeds to read `RESULT.json`.

## The result contract

`agent-result.ts` appends to every prompt: leave `result.path` (default
`RESULT.json`, relative, no `..`) in the workspace, a JSON object with at least
`status: "done" | "blocked"` and `summary`, plus the task's `result.schema` (read
relative to `agent.yaml` and kept under it) as JSON; and "do not publish, push or
deploy anything". After turn 1 the runner reads it. Only a **missing** file
(`ENOENT`/`ENOTDIR`) gets one nudge turn in the same session ("You have not written
RESULT.json. Write it now and do nothing else." plus the contract); a file that exists
but is not JSON, lacks `status` or `summary`, or fails the schema fails the attempt at
once. Still missing or invalid after the nudge fails the attempt. Both failures are
plain `Error`, so `retry` repeats the run in a fresh workspace with the error in the
prompt.

`done`: the `post` gates run in order, each a `shell` argv in the workspace with the
scope gaining `result`, skipped when its `when` is falsy (`agent.post_gate`); a
non-zero exit is rethrown as `post[i] (<cmd>) failed: exit code N: <stderr tail>`,
retryable. `blocked`: the gates are skipped and the run **succeeds** with the document
as its result, so `emit … when: "result.status == 'blocked'"` routes it. The run result
is the `RESULT.json` document in both cases.

## Retries

On `run.attempt > 1` with a non-empty `run.error`, the prompt gains, between the task's
prompt and the contract: "This is attempt N. The previous attempt failed with this
error:" plus the first 2000 characters, "Its changes were discarded: you are starting
again from a fresh working directory. Avoid what caused that failure." The executor
hands each attempt the previous one's error as `run.error`, read back from the store
after a restart. The workspace of the failed attempt is removed first.

## The workspace

`agent-workspace.ts`: `<defaults.agent.work_dir>/<run_id>` (`work_dir` defaults to
`work/` next to the database; the runner uses its real path for policy comparisons),
exposed as `${run.workspace}`. `git-worktree` runs `git -C <repo> worktree add -B
agent/<run_id> <path> <branch>` (`branch` default `main`); `temp` is an empty directory.
A leftover from an earlier attempt is removed first. The workspace is kept only after
the result was read and the gates passed (`blocked` included), for the gates, a later
publishing task and inspection; otherwise `worktree remove --force`, `rmSync` and
`branch -D agent/<run_id>` (`agent.workspace_removed`). Retention sweeps kept
workspaces `retention.workspaces` after the run finished ([`store.md`](store.md)).

## The transcript

`agent-transcript.ts` writes rows `(run_id, ts, turn, kind, text, data)` to the
`transcripts` table through `ctx.transcripts` (nothing is written without a store
sink): the `prompt` (turn 1; the nudge is turn 2), `text` and `thought` chunks
coalesced per contiguous run of the same kind (flushed when the kind changes or any
structured row is written, not by message id), each `tool_call` and
`tool_call_update` (id, title, kind, status, command, locations; tool output is not
stored), every `permission` decision with `allowed`, `option_id` and the reason, each
`usage` report, the `stop`, a `cancel` by the core (`budget`, `tool_calls`, `policy`,
abort) and the `result`. A permission row can precede the `tool_call` it answers.
Before a row is written, every secret value resolved for the run that is 4 characters
or longer (`REDACT_MIN`) is replaced by `[secret:<name>]`, longest first; a text past
64 000 characters (`TRANSCRIPT_TEXT_MAX`) is split across rows. A throwing sink logs
`agent.transcript_failed` once and later rows of that run are dropped; the run
continues. `GET /v1/runs/{id}/transcript` and `oa runs logs <id>` read it back; the
rows go with the run when retention deletes it.

## Tests

`actions/agent*.test.ts` and `integration.agent.test.ts` run against
`packages/core/test/fixtures/fake-acp.ts`, a real ACP agent process scripted by
markers in the prompt, never a model; `test/smoke/acp/` runs the same action against
real agents ([`testing.md`](testing.md)).

## Invariants a change must keep

- Every permission request is judged against `tools`, `bash_allow` and the workspace,
  per call; `allow_always` is never granted; `mode` is never exposed.
- Every reported tool call is judged after the fact; a violation cancels and fails
  non-retryably.
- Every turn is ledgered through `ctx.llm.record`; a turn with nothing to price fails.
- The agent gets a workspace, a bridge socket and a token, never the daemon's socket,
  a connector's secrets or a deploy credential.
- `blocked` succeeds, `done` runs the gates, and nothing leaves the workspace unless a
  separate task takes it.
