/**
 * The non-LLM path of `docs/examples/orchestra-website.yaml` end to end on a real daemon:
 * fake email and chat connectors (real child processes speaking MCP over stdio and
 * emitting events over the socket), the two model-backed tasks replaced by
 * shell stand-ins that produce the same events, `publish_site` replaced by an echo that
 * still holds the FTP secret. A manual run of `fetch_email` must end with `publish_site`
 * succeeded and `notify` called, one correlation id throughout, and no secret anywhere it
 * should not be.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from './api/client.js';
import { startDaemon, type Daemon } from './daemon.js';
import { createLogger } from './log.js';

const FIXTURES = new URL('../test/fixtures/', import.meta.url).pathname;

const SECRETS = { ftp_pass: 'hunter2-ftp', imap_user: 'bob@example.cz', chat_token: 'tok-123' };

const AGENT = `
db: state.db
socket: core.sock
tasks: tasks.yaml
log: { level: debug }
secrets: { backend: file, path: secrets.yaml }
defaults: { retry: { attempts: 2, backoff: fixed, base: 50ms } }
connectors:
  - name: email
    exec: [node, ${FIXTURES}fake-email.ts]
    emits: [email.received]
    ops: [fetch_new, mark_read]
    config:
      user: "\${secrets.imap_user}"
      mails:
        - { uid: 1, message_id: "<m1@x>", from: orchestrator@example.cz, subject: Spring concert, body: Please add the spring concert on May 3. }
        - { uid: 2, message_id: "<m2@x>", from: spam@example.com, subject: Buy now, body: no }
  - name: chat
    exec: [node, ${FIXTURES}fake-chat.ts]
    emits: [chat.reply]
    ops: [send, ask]
    config: { token: "\${secrets.chat_token}", delay_ms: 30 }
`;

const TASKS = `
tasks:
  # 1. Poll the mailbox (as in the example).
  - name: fetch_email
    trigger: { kind: cron, schedule: "*/2 * * * *", overlap: skip }
    action:
      kind: connector
      connector: email
      op: fetch_new
      args: { folder: INBOX, since_uid: "\${state.email.last_uid}" }
    state_updates:
      email.last_uid: \${result.last_uid}
    emit:
      - type: email.received
        each: \${result.emails}
        dedup_key: "email:\${item.message_id}"
        payload: \${item}

  # 2. Stand-in for the llm classifier: same trigger, filter and emit.
  - name: classify_orchestra_email
    trigger:
      kind: event
      type: email.received
      filter: "payload.from == 'orchestrator@example.cz'"
    action:
      kind: shell
      cmd: [echo, '{"kind":"general_change","summary":"\${event.payload.subject}"}']
      result: json_stdout
    emit:
      - type: orchestra.classified
        when: "result.kind != 'ignore'"
        payload:
          kind: \${result.kind}
          summary: \${result.summary}
          email: \${event.payload}

  # 4. Stand-in for the agent: emits the same orchestra.change_ready.
  - name: update_site_general
    trigger:
      kind: event
      type: orchestra.classified
      filter: "payload.kind == 'general_change'"
    concurrency: 1
    action:
      kind: shell
      cmd: [echo, '{"summary":"\${event.payload.summary}","diff_stat":"1 file changed"}']
      result: json_stdout
    emit:
      - type: orchestra.change_ready
        payload: { summary: "\${result.summary}", diff: "\${result.diff_stat}", worktree: "/tmp" }

  # 4b. Approval gate via chat (as in the example, push replaced by an echo).
  - name: approve_general_change
    trigger: { kind: event, type: orchestra.change_ready }
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: chat
          op: ask
          args:
            text: "Site change ready: \${event.payload.summary}\\n\${event.payload.diff}\\nApprove?"
            correlation_id: \${event.correlation_id}
        - kind: wait
          for: { type: chat.reply, filter: "payload.correlation_id == '\${event.correlation_id}'" }
          timeout: 24h
          on_timeout: fail
        - kind: shell
          when: "steps[1].payload.approved == \`true\`"
          cwd: \${event.payload.worktree}
          cmd: [echo, "git push origin HEAD:main"]

  # 5. Publish: holds the FTP secret, replaced by an echo.
  - name: publish_site
    trigger:
      kind: event
      type_any: [task.update_event_list.succeeded, task.approve_general_change.succeeded]
    concurrency: 1
    action:
      kind: shell
      env: { LFTP_PASSWORD: "\${secrets.ftp_pass}" }
      cmd: [sh, -c, 'test -n "$LFTP_PASSWORD" && echo published']

  # 6. Tell the human (as in the example).
  - name: notify
    trigger:
      kind: event
      type_any: [task.publish_site.succeeded, "task.*.failed", budget.exceeded]
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "[247-agent] \${event.type}: \${event.payload.summary || event.payload.error}" }
`;

let dir: string;
let daemon: Daemon;
let api: ApiClient;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-i-'));
  writeFileSync(join(dir, 'agent.yaml'), AGENT);
  writeFileSync(join(dir, 'tasks.yaml'), TASKS);
  writeFileSync(
    join(dir, 'secrets.yaml'),
    Object.entries(SECRETS)
      .map(([k, v]) => `${k}: "${v}"`)
      .join('\n') + '\n',
  );
  lines = [];
  daemon = await startDaemon({
    configFile: join(dir, 'agent.yaml'),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
  });
  api = new ApiClient({ socketPath: daemon.config.socket });
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function until(pred: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('orchestra workflow without a model', () => {
  it('runs fetch_email → … → publish_site → notify on one correlation id, secrets contained', async () => {
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);

    const { event_id, run: first } = await api.run('fetch_email');
    await until(
      async () => (await api.listRuns({ task: 'notify', status: 'succeeded' })).length === 1,
    );
    await daemon.core.executor.idle();

    const runs = await api.listRuns({ limit: 100 });
    const byTask = new Map(runs.map((r) => [r.task, r]));
    expect([...byTask.keys()].sort()).toEqual([
      'approve_general_change',
      'classify_orchestra_email',
      'fetch_email',
      'notify',
      'publish_site',
      'update_site_general',
    ]);
    expect(runs).toHaveLength(6); // the spam mail never reaches the classifier
    for (const run of runs) {
      expect(run, run.task).toMatchObject({
        status: 'succeeded',
        correlation_id: first.correlation_id,
      });
    }
    expect(byTask.get('fetch_email')?.result).toMatchObject({ last_uid: 2 });
    expect(byTask.get('publish_site')?.result).toBe('published');
    expect(byTask.get('approve_general_change')?.result).toMatchObject({
      steps: [
        { asked: true, question: expect.stringContaining('Spring concert') as string },
        { type: 'chat.reply', payload: { approved: true, correlation_id: first.correlation_id } },
        'git push origin HEAD:main',
      ],
    });

    // State: the email cursor advanced, the chat connector recorded the notification.
    expect((await api.getState('email', 'last_uid'))?.value).toBe(2);
    expect((await api.getState('chat', 'sent'))?.value).toEqual([
      '[247-agent] task.publish_site.succeeded: ',
    ]);

    // One correlation id from the manual run to the last lifecycle event, chat reply included.
    const events = daemon.core.store.events.listAfter(0, 1000);
    expect(events[0]?.id).toBe(event_id);
    expect(new Set(events.map((e) => e.correlation_id))).toEqual(new Set([first.correlation_id]));
    expect(events.map((e) => e.type)).toEqual([
      'manual.run',
      'task.fetch_email.succeeded',
      'email.received',
      'email.received',
      'task.classify_orchestra_email.succeeded',
      'orchestra.classified',
      'task.update_site_general.succeeded',
      'orchestra.change_ready',
      'chat.reply',
      'task.approve_general_change.succeeded',
      'task.publish_site.succeeded',
      'task.notify.succeeded',
    ]);
    expect(events.find((e) => e.type === 'chat.reply')?.source).toBe('chat');

    // No secret value in the database, the log or any event payload.
    daemon.core.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const db = readFileSync(join(dir, 'state.db'), 'latin1');
    const log = JSON.stringify(lines);
    const payloads = JSON.stringify(events);
    for (const value of Object.values(SECRETS)) {
      expect(db).not.toContain(value);
      expect(log).not.toContain(value);
      expect(payloads).not.toContain(value);
    }
    expect(log).toContain('fetch_new folder=INBOX'); // connector stderr did reach the log

    // A second poll finds nothing new and emits nothing: the cursor and dedup both hold.
    const again = await api.run('fetch_email');
    await until(async () => (await api.getRun(again.run.id)).status === 'succeeded');
    expect(
      daemon.core.store.events.listAfter(0, 1000).filter((e) => e.type === 'email.received'),
    ).toHaveLength(2);
  }, 30_000);
});
