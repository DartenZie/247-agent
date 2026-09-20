# Task patterns

Copy the shape that fits; all of these validate and run today unless marked.

## Poll with a cursor and fan out (no model)

```yaml
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
```

`overlap: skip` + the cursor in `state` + `dedup_key` make the poll idempotent.

## React to an event, filter first

```yaml
- name: classify_orchestra_email
  trigger:
    kind: event
    type: email.received
    filter: "payload.from == 'orchestrator@example.cz'"
  action: { ... }
  emit:
    - type: orchestra.classified
      when: "result.kind != 'ignore'"
      payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

## Chain on another task's success

```yaml
- name: publish_site
  trigger:
    kind: event
    type_any: [task.update_event_list.succeeded, task.approve_general_change.succeeded]
  concurrency: 1
  action:
    kind: shell
    cwd: /var/lib/247-agent/repos/site
    env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
    cmd: ["bash", "-c", "git pull --ff-only origin main && npm run build && lftp -u \"$FTP_USER\",env:LFTP_PASSWORD -e 'mirror -R --delete dist/ /public_html; quit' sftp://ftp.example.cz"]
```

The publisher is the only task holding the deploy secret. A mirror is idempotent, so a
retry is safe.

## Notify on any failure

```yaml
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

Safe by construction: a task never triggers on its own `task.notify.failed`.

## Approval gate (ask, wait, act)

```yaml
- name: approve_general_change
  trigger: { kind: event, type: orchestra.change_ready }
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
```

Match the reply on `correlation_id`, never on "the next reply". The connector's `ask`
op must carry the id into the reply payload.

## Scheduled shell report

```yaml
- name: disk_report
  trigger: { kind: cron, schedule: "0 8 * * *", tz: Europe/Prague }
  action: { kind: shell, cmd: ["df", "-h", "/"], result: text_stdout }
  emit:
    - type: report.disk
      payload: { text: "${result}" }
```

## Manual-only maintenance task

```yaml
- name: rebuild_site
  trigger: { kind: manual }
  timeout: 30m
  action: { kind: shell, cwd: /var/lib/247-agent/repos/site, cmd: ["npm", "run", "build"] }
```

Run with `oa run rebuild_site --wait`.

## Stand-in for a model step (until `llm`/`agent` run)

Keep the same name, trigger, filter and `emit` so downstream tasks are exercised
unchanged; replace only the action. This is how the integration test drives the
orchestra workflow without a model.

```yaml
- name: classify_orchestra_email
  trigger: { kind: event, type: email.received, filter: "payload.from == 'orchestrator@example.cz'" }
  action:
    kind: shell
    cmd: [echo, '{"kind":"general_change","summary":"${event.payload.subject}"}']
    result: json_stdout
  emit:
    - type: orchestra.classified
      when: "result.kind != 'ignore'"
      payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

## Replay a real event through a task

Save the event as `{"type": "email.received", "payload": {...}}` and run
`oa run classify_orchestra_email --event mail.json --wait`. The action sees it as
`event` (under the manual run's ids); filters are bypassed, so this tests the action
and `emit`, while `oa emit email.received mail.json` tests the trigger and filter too.
