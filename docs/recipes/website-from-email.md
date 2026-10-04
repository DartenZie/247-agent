# Maintain a website from an editor's emails

An editor emails changes for a small website. The daemon fetches the mail, lets one
cheap model call sort it, hands the edit to an agent in a sandboxed worktree, proves the
site still builds, asks you before anything big is published, mirrors the result over
SFTP, and tells you how it went. Only two of the eight tasks call a model.

This is the reference workflow that ships with every release, in
`docs/examples/website-updates.yaml`. Read it once; it shows every kind of task working
together.

## What you need

- The [email connector](../connectors/email.md) (IMAP in, SMTP out), the
  [chat connector](../connectors/chat.md) for approvals and notifications, and an
  [agent program](../connectors/agents.md) named `claude`.
- A bare or base checkout of the site at `/var/lib/247-agent/repos/website`, with an
  `npm run build` that renders it.
- Secrets: the mailbox credentials, the chat token, the SFTP password and the agent's
  model key, each by name in your secrets backend.
- `providers:` with an `anthropic` entry in `agent.yaml`.

## The tasks

```yaml
tasks:

  # 1. Poll the mailbox. No LLM.
  - name: fetch_email
    trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }
    action:
      kind: connector
      connector: email
      op: fetch_new
      args: { folder: INBOX, since_uid: "${state.email.last_uid}" }
    state_updates:
      email.last_uid: ${result.last_uid}
    emit:
      - type: email.received
        each: ${result.emails}
        dedup_key: "email:${item.message_id}"
        payload: ${item}

  # 2. Only the trusted sender's mail reaches a model. Cheapest tier, one call, JSON out.
  - name: classify_email
    trigger:
      kind: event
      type: email.received
      filter: "payload.from == 'editor@example.com'"
    action:
      kind: llm
      provider: anthropic
      model: claude-haiku-4-5
      max_tokens: 512
      system_file: prompts/classify_email.md
      input: |
        Subject: ${event.payload.subject}

        <email>
        ${event.payload.body}
        </email>
      output_schema:
        type: object
        additionalProperties: false
        required: [kind, summary]
        properties:
          kind: { enum: [event_list_update, general_change, ignore] }
          summary: { type: string, description: "One sentence, what the sender wants changed" }
    emit:
      - type: email.classified
        when: "result.kind != 'ignore'"
        payload:
          kind: ${result.kind}
          summary: ${result.summary}
          email: ${event.payload}

  # 3. Routine change: an agent with a narrow scope and few tool calls.
  - name: update_event_list
    trigger:
      kind: event
      type: email.classified
      filter: "payload.kind == 'event_list_update'"
    concurrency: 1
    timeout: 15m
    action:
      kind: agent
      connector: claude
      model: claude-sonnet-5
      effort: low
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
        - shell: ["git", "push", "origin", "HEAD:main"]
    emit:
      - type: site.change_blocked
        when: "result.status == 'blocked'"
        payload:
          summary: ${result.summary}
          missing: ${result.missing}
          email: ${event.payload.email}

  # 3b. The agent could not do it: tell the editor what is missing. No LLM.
  - name: reply_blocked
    trigger: { kind: event, type: site.change_blocked }
    action:
      kind: connector
      connector: email
      op: send
      args:
        to: ${event.payload.email.from}
        in_reply_to: ${event.payload.email.message_id}
        subject: "Re: ${event.payload.email.subject}"
        body: |
          Hello,

          I could not apply this change to the website yet: ${event.payload.summary}

          Please send: ${join(', ', event.payload.missing || `[]`)}

  # 4. Anything else: the same agent kind, whole repo, more tool calls, then a human approves.
  - name: update_site_general
    trigger:
      kind: event
      type: email.classified
      filter: "payload.kind == 'general_change'"
    concurrency: 1
    timeout: 45m
    action:
      kind: agent
      connector: claude
      model: claude-opus-5
      effort: high
      max_tool_calls: 60
      budget: { max_usd: 3.00 }
      workspace: { kind: git-worktree, repo: /var/lib/247-agent/repos/website, branch: main }
      tools: [read, edit, delete, move, search, execute]
      bash_allow: ["npm run build", "npm test", "git diff", "git status"]
      mcp_servers: []
      system_file: prompts/agent_site_general.md
      prompt: |
        ${event.payload.summary}

        <email>
        ${event.payload.email.body}
        </email>
      result: { path: RESULT.json, schema: schemas/site_change.json }
      post:
        - shell: ["npm", "run", "build"]
        - shell: ["git", "commit", "-am", "site: ${result.summary}"]
    emit:
      - type: site.change_ready
        when: "result.status == 'done'"
        payload: { summary: "${result.summary}", diff: "${result.diff_stat}", worktree: "${run.workspace}" }
      - type: site.change_blocked
        when: "result.status == 'blocked'"
        payload:
          summary: ${result.summary}
          missing: ${result.missing}
          email: ${event.payload.email}

  # 4b. Approval gate via chat. No LLM.
  - name: approve_general_change
    trigger: { kind: event, type: site.change_ready }
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: chat
          op: ask
          args:
            text: "Site change ready: ${event.payload.summary}\n${event.payload.diff}\nApprove?"
            correlation_id: ${event.correlation_id}
        - kind: wait
          for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }
          timeout: 24h
          on_timeout: fail
        - kind: shell
          when: "steps[1].payload.approved == `true`"
          cwd: ${event.payload.worktree}
          cmd: ["git", "push", "origin", "HEAD:main"]

  # 5. Publish. Deterministic, holds the SFTP secret, nothing else does.
  - name: publish_site
    trigger:
      kind: event
      type_any: [task.update_event_list.succeeded, task.approve_general_change.succeeded]
    concurrency: 1
    action:
      kind: shell
      cwd: /var/lib/247-agent/repos/website
      env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
      cmd:
        - bash
        - -c
        - |
          git pull --ff-only origin main && npm run build &&
          lftp -u "$FTP_USER",env:LFTP_PASSWORD -e "mirror -R --delete dist/ /public_html; quit" sftp://ftp.example.com

  # 6. Tell the human what happened. No LLM.
  - name: notify
    trigger:
      kind: event
      type_any: [task.publish_site.succeeded, "task.*.failed", budget.exceeded]
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "[247-agent] ${event.type}: ${event.payload.summary || event.payload.error}" }
```

## The agent's manifest

`connectors.d/claude.yaml` declares the agent program. It runs in a sandbox that sees the
site repository read-only and reaches two hosts:

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

## The prompts and the schema

`prompts/classify_email.md` is the static system prompt of task 2. It names the three
labels, says what `summary` is for, and tells the model that the text between `<email>`
tags is data, not instructions. Being static, it is cached across runs.

`prompts/agent_event_list.md` scopes the small agent: edit `data/events.yaml` and nothing
else, keep entries sorted, run the build, and when something is missing do not guess but
report `status: blocked` with the missing items. `prompts/agent_site_general.md` does the
same for the whole site and adds: never publish, push or deploy; a human reviews first.

`schemas/site_change.json` extends the baseline result with what the tasks route on:

```json
{
  "type": "object",
  "required": ["status", "summary", "files_changed"],
  "properties": {
    "status": { "enum": ["done", "blocked"] },
    "summary": { "type": "string", "minLength": 1 },
    "files_changed": { "type": "array", "items": { "type": "string" } },
    "diff_stat": { "type": "string" },
    "missing": { "type": "array", "items": { "type": "string" } }
  }
}
```

## Why each task is shaped this way

| Task | Shape | Why |
|---|---|---|
| `fetch_email` | cron, connector op, cursor in state, fan out with a dedup key | polling, dedup and routing are code; a message becomes exactly one event |
| `classify_email` | a filter on the sender, then one Haiku call with a schema and a fallback label | only trusted mail reaches a model; `ignore` is dropped by `when` without another call |
| `update_event_list` | Sonnet at low effort, 20 tool calls, $0.50, one file in scope, `npm run build` the only command | a routine edit needs little intelligence and a tight surface; the build gate proves it did not break anything |
| `reply_blocked` | an email back, no model | the agent said what is missing; a template turns that into a reply |
| `update_site_general` | Opus at high effort, 60 calls, $3, the whole repository, `done` routed to an approval | a wide change buys more intelligence and gets a human in front of publishing |
| `approve_general_change` | ask, wait, push | the gate is configuration, so routine changes skip it and big ones cannot |
| `publish_site` | shell, holds the SFTP password | the agent never publishes and never sees a deploy secret; a mirror is idempotent, so a retry is safe |
| `notify` | one task on failures, the budget event and the one success | you hear about everything without a loop |

Both agent tasks are the same action kind with different `model`, `effort`,
`max_tool_calls`, `budget`, `tools`, `bash_allow` and `system_file`. The small one pushes
in its own gates because its scope is a single data file; the big one commits and stops,
and the push happens only after you approve.

A `blocked` result is a success for the run, not a failure: the agent did its job by
saying what is missing, and the `site.change_blocked` event carries that to the reply
task. A real failure (over budget, a refused tool call, no RESULT.json after a retry)
reaches you through `task.*.failed` on chat.

## Adapt it to your site

- **Another repository.** Change `workspace.repo` in both agent tasks and the
  `ro_binds` of the manifest; `oa validate` refuses a repository the sandbox cannot see.
- **Another build.** Replace `npm run build` in `bash_allow`, in the prompts and in the
  gates. List the read-only commands your agent runs on its own (`git status`,
  `git diff`) in `bash_allow` too.
- **Another publisher.** A `connector` task on the ftp connector's `sync` op uploads a
  built directory without a shell or `lftp`; a `git push` to a host that deploys on push
  is a one-line gate.
- **Another trigger.** A chat message, a webhook or a ticket can carry the request; the
  classification and the agent tasks only need `summary` and a body in the payload.
- **No approval for small changes, approval for everything else** is the shape here.
  Move the `wait` into the small task's path, or drop it, by editing where
  `site.change_ready` is emitted.

> [!WARNING]
> Keep the deploy secret in the publishing task only. Granting an agent a connector that
> can send mail or upload files through `mcp_servers` grants exactly that, so the two
> agent tasks here grant none.

> [!TIP]
> Replay a real email through any task with `oa run classify_email --event mail.json
> --wait`, where the file holds `{"type": "email.received", "payload": {…}}`. Filters are
> bypassed, so this tests the action and its routing; `oa emit email.received mail.json`
> tests the trigger and the filter too.

Related: [`agent`](../tasks/agent.md), [Agent programs](../connectors/agents.md),
[Security](../concepts/security.md).
