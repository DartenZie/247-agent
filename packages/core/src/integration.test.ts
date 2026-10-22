/**
 * `docs/examples/website-updates.yaml` end to end on a real daemon without a model:
 * fake email and chat connectors (real child processes speaking MCP over stdio and
 * emitting events over the socket), the `llm` classifier run through the real service
 * against a fake Anthropic adapter (ledger, budgets and secret resolution are real),
 * the `agent` task replaced by a shell stand-in that produces the same event,
 * `publish_site` replaced by an echo that still holds the FTP secret. A manual run of `fetch_email` must end with `publish_site`
 * succeeded and `notify` called, one correlation id throughout, and no secret anywhere it
 * should not be.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { ApiClient } from './api/client.js';
import { startDaemon, type Daemon } from './daemon.js';
import { fakeProviderFactory, type FakeProvider } from './llm/testing.js';
import { createLogger } from './log.js';

const FIXTURES = new URL('../test/fixtures/', import.meta.url).pathname;
const EXAMPLE = new URL('../../../docs/examples/website-updates.yaml', import.meta.url).pathname;
const DIGEST = new URL('../../../connectors/email/examples/daily-digest.yaml', import.meta.url)
  .pathname;
const PROMPT = new URL('../../../docs/examples/prompts/classify_email.md', import.meta.url)
  .pathname;

const SECRETS = {
  ftp_pass: 'hunter2-ftp',
  imap_user: 'bob@example.com',
  chat_token: 'tok-123',
  anthropic_api_key: 'sk-ant-api03-not-real',
};

const AGENT = `
db: state.db
socket: core.sock
tasks: tasks.yaml
log: { level: debug }
secrets: { backend: file, path: secrets.yaml }
defaults:
  retry: { attempts: 2, backoff: fixed, base: 50ms }
  llm: { provider: anthropic, model: claude-haiku-4-5 }
providers:
  anthropic: { type: anthropic, api_key: "\${secrets.anthropic_api_key}" }
budgets: { daily_usd: 1 }
connectors:
  - name: email
    exec: [node, ${FIXTURES}fake-email.ts]
    emits: [email.received]
    ops: [fetch_new, mark_read, send]
    config:
      user: "\${secrets.imap_user}"
      mails:
        - { uid: 1, message_id: "<m1@x>", from: editor@example.com, subject: Spring event, body: Please add the spring event on May 3. }
        - { uid: 2, message_id: "<m2@x>", from: spam@example.com, subject: Buy now, body: no }
  - name: chat
    exec: [node, ${FIXTURES}fake-chat.ts]
    emits: [chat.reply]
    ops: [send, ask]
    config: { token: "\${secrets.chat_token}", delay_ms: 30 }
  - name: ftp
    exec: [node, ${FIXTURES}fake-ftp.ts]
    ops: [list, stat, read, write, delete, rename, mkdir]
    config:
      files: { "incoming/orders.csv": "id;qty|1;2", "incoming/notes/readme.txt": "skip me" }
`;

const TASKS_INLINE = `
tasks:
  # 1. Poll the mailbox (as in the example, where it is a */2 cron). Manual here: the test
  #    runs it by hand, and a cron would fire a second poll whenever the test crosses an
  #    even minute.
  - name: fetch_email
    trigger: { kind: manual }
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

  # 2. The llm classifier as in the example; the adapter is faked, the service is real.
  - name: classify_email
    trigger:
      kind: event
      type: email.received
      filter: "payload.from == 'editor@example.com'"
    action:
      kind: llm
      max_tokens: 512
      system_file: prompts/classify_email.md
      input: |
        Subject: \${event.payload.subject}

        <email>
        \${event.payload.body}
        </email>
      output_schema:
        type: object
        additionalProperties: false
        required: [kind, summary]
        properties:
          kind: { enum: [event_list_update, general_change, ignore] }
          summary: { type: string }
      budget: { max_usd: 0.05 }
    emit:
      - type: email.classified
        when: "result.kind != 'ignore'"
        payload:
          kind: \${result.kind}
          summary: \${result.summary}
          email: \${event.payload}

  # 4. Stand-in for the agent: emits the same site.change_ready.
  - name: update_site_general
    trigger:
      kind: event
      type: email.classified
      filter: "payload.kind == 'general_change'"
    concurrency: 1
    action:
      kind: shell
      cmd: [echo, '{"summary":"\${event.payload.summary}","diff_stat":"1 file changed"}']
      result: json_stdout
    emit:
      - type: site.change_ready
        payload: { summary: "\${result.summary}", diff: "\${result.diff_stat}", worktree: "/tmp" }

  # 4b. Approval gate via chat (as in the example, push replaced by an echo).
  - name: approve_general_change
    trigger: { kind: event, type: site.change_ready }
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

  # 5. Publish: holds the FTP secret, replaced by an echo; the trigger is the example's.
  - name: publish_site
    trigger: { kind: manual }
    concurrency: 1
    action:
      kind: shell
      env: { LFTP_PASSWORD: "\${secrets.ftp_pass}" }
      cmd: [sh, -c, 'test -n "$LFTP_PASSWORD" && echo published']

  # 7. The ftp example (connectors/ftp/examples/inbox-import.yaml) on the fake connector:
  #    manual instead of cron so it never fires into the workflow above.
  - name: scan_incoming
    trigger: { kind: manual }
    action: { kind: connector, connector: ftp, op: list, args: { path: incoming } }
    emit:
      - type: ftp.file_seen
        each: "\${result.entries[?type == 'file']}"
        dedup_key: "ftp:\${item.path}:\${item.size}:\${item.mtime}"
        payload: \${item}
  - name: import_file
    trigger: { kind: event, type: ftp.file_seen }
    action:
      kind: sequence
      steps:
        - { kind: connector, connector: ftp, op: read, args: { path: "\${event.payload.path}" } }
        - kind: connector
          connector: ftp
          op: rename
          args: { from: "\${event.payload.path}", to: "processed/\${event.payload.name}", parents: true }
    emit:
      - type: ftp.file_imported
        payload:
          name: \${event.payload.name}
          content: \${result.steps[0].content}
          moved_to: \${result.steps[1].to}

  # 6. Tell the human (as in the example).
  - name: notify
    trigger:
      kind: event
      type_any: [task.publish_site.succeeded, "task.*.failed", budget.exceeded]
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "[247-agent] \${event.type} (\${event.payload.task}): \${event.payload.error || event.payload.spent_usd || 'ok'}" }
`;

interface Task {
  name: string;
  trigger?: unknown;
  action?: unknown;
  emit?: unknown;
}
const example = (parse(readFileSync(EXAMPLE, 'utf8')) as { tasks: Task[] }).tasks;
const fromExample = (name: string): Task => {
  const task = example.find((t) => t.name === name);
  if (!task) {
    throw new Error(`no ${name} in the example`);
  }
  return task;
};
/**
 * 3. Stand-in for the agent with the example's routing: the result's `status` comes from
 *    the trigger event, so a test picks `done` or `blocked`.
 */
const updateEventList = {
  ...fromExample('update_event_list'),
  action: {
    kind: 'shell',
    cmd: [
      'echo',
      '{"status":"${event.payload.status}","summary":"${event.payload.summary}","missing":["dates"]}',
    ],
    result: 'json_stdout',
  },
};
/** 3a. The example's push task with its routing, the push replaced by an echo. */
const pushEventList = {
  ...fromExample('push_event_list'),
  action: { kind: 'shell', cmd: ['echo', 'git push origin HEAD:main'] },
};
/** 3b. `reply_blocked` verbatim from the example, so its `send` args meet the connector's rules. */
const replyBlocked = fromExample('reply_blocked');
/** 8. `email_digest` verbatim from the email example, manual instead of its weekday cron. */
const emailDigest = {
  ...(parse(readFileSync(DIGEST, 'utf8')) as { tasks: { name: string }[] }).tasks.find(
    (t) => t.name === 'email_digest',
  ),
  trigger: { kind: 'manual' },
};
/** The gate's `emit` and `publish_site`'s trigger are the example's, so its routing is tested. */
const inline = (parse(TASKS_INLINE) as { tasks: Task[] }).tasks.map((t) =>
  t.name === 'approve_general_change'
    ? { ...t, emit: fromExample(t.name).emit }
    : t.name === 'publish_site'
      ? { ...t, trigger: fromExample(t.name).trigger }
      : t,
);
const TASKS = stringify({
  tasks: [...inline, updateEventList, pushEventList, replyBlocked, emailDigest],
});

let dir: string;
let daemon: Daemon;
let api: ApiClient;
let lines: Record<string, unknown>[];
let model: FakeProvider;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-i-'));
  writeFileSync(join(dir, 'agent.yaml'), AGENT);
  writeFileSync(join(dir, 'tasks.yaml'), TASKS);
  mkdirSync(join(dir, 'prompts'));
  copyFileSync(PROMPT, join(dir, 'prompts', 'classify_email.md'));
  model = fakeProviderFactory((req) => ({
    output: { kind: 'general_change', summary: /^Subject: (.*)$/m.exec(req.input)?.[1] ?? '' },
    usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 600 },
    stopReason: 'end',
  }));
  writeFileSync(
    join(dir, 'secrets.yaml'),
    Object.entries(SECRETS)
      .map(([k, v]) => `${k}: "${v}"`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await boot();
});

async function boot(): Promise<void> {
  lines = [];
  daemon = await startDaemon({
    configFile: join(dir, 'agent.yaml'),
    llmFactories: { anthropic: model.factory },
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
  });
  api = new ApiClient({ socketPath: daemon.config.socket });
}

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

describe('website workflow without a model', () => {
  it('runs fetch_email → … → publish_site → notify on the mail correlation id, secrets contained', async () => {
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
      'classify_email',
      'fetch_email',
      'notify',
      'publish_site',
      'update_site_general',
    ]);
    expect(runs).toHaveLength(6); // the spam mail never reaches the classifier
    // The tick keeps its correlation; the mail starts its own, which every later run shares.
    const mail = byTask.get('classify_email')?.correlation_id;
    expect(mail).not.toBe(first.correlation_id);
    for (const run of runs) {
      expect(run, run.task).toMatchObject({
        status: 'succeeded',
        correlation_id: run.task === 'fetch_email' ? first.correlation_id : mail,
      });
    }
    expect(byTask.get('fetch_email')?.result).toMatchObject({ last_uid: 2 });
    expect(byTask.get('publish_site')?.result).toBe('published');
    expect(byTask.get('approve_general_change')?.result).toMatchObject({
      steps: [
        { message_id: 1, chat_id: '1', options: ['Approve', 'Reject'] },
        { type: 'chat.reply', payload: { approved: true, correlation_id: mail } },
        'git push origin HEAD:main',
      ],
    });

    // The classifier: one real call through the service, prompt file and event rendered in,
    // the key resolved for the adapter only, and one priced ledger row behind `oa cost`.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.provider).toMatchObject({
      name: 'anthropic',
      apiKey: SECRETS.anthropic_api_key,
    });
    expect(model.requests[0]?.req).toMatchObject({
      model: 'claude-haiku-4-5',
      maxTokens: 512,
      system: expect.stringContaining('You triage emails') as string,
      input: expect.stringContaining('Spring event') as string,
    });
    expect(byTask.get('classify_email')?.result).toEqual({
      kind: 'general_change',
      summary: 'Spring event',
    });
    const cost = await api.cost({ by: 'task' });
    expect(cost.rows).toEqual([
      expect.objectContaining({ key: 'classify_email', calls: 1, in_tok: 900, cache_write: 600 }),
    ]);
    expect(cost.total_usd).toBeGreaterThan(0);
    expect(cost.total_usd).toBeLessThan(0.05);

    // State: the email cursor advanced, the chat connector recorded the notification.
    expect((await api.getState('email', 'last_uid'))?.value).toBe(2);
    expect((await api.getState('chat', 'sent'))?.value).toEqual([
      '[247-agent] task.publish_site.succeeded (publish_site): ok',
    ]);
    expect((await api.getState('chat', 'asked'))?.value).toEqual([
      expect.stringContaining('Spring event') as string,
    ]);

    // The manual run's correlation covers the fetch; each mail has its own from there to the
    // last lifecycle event, chat reply included.
    const events = daemon.core.store.events.listAfter(0, 1000);
    expect(events[0]?.id).toBe(event_id);
    const tick = new Set(['manual.run', 'task.fetch_email.succeeded']);
    const received = events.filter((e) => e.type === 'email.received');
    const spam = received.find((e) => e.correlation_id !== mail);
    expect(spam?.correlation_id).not.toBe(first.correlation_id);
    for (const e of events) {
      const expected = tick.has(e.type)
        ? first.correlation_id
        : e === spam
          ? spam.correlation_id
          : mail;
      expect(e.correlation_id, e.type).toBe(expected);
    }
    expect(events.map((e) => e.type)).toEqual([
      'manual.run',
      'task.fetch_email.succeeded',
      'email.received',
      'email.received',
      'task.classify_email.succeeded',
      'email.classified',
      'task.update_site_general.succeeded',
      'site.change_ready',
      'chat.reply',
      'task.approve_general_change.succeeded',
      'site.change_pushed',
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

/** Runs everything a published event started, then the publish_site runs, if any. */
async function publishRuns(): Promise<unknown[]> {
  daemon.core.bus.dispatcher.drain();
  await daemon.core.executor.idle();
  return api.listRuns({ task: 'publish_site' });
}

describe('publishing in the example', () => {
  it('publishes nothing after a rejected approval', async () => {
    await daemon.stop();
    writeFileSync(
      join(dir, 'agent.yaml'),
      AGENT.replace('delay_ms: 30 }', 'delay_ms: 30, approve: false }'),
    );
    await boot();
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);

    await api.emit({
      type: 'site.change_ready',
      source: 'test',
      payload: { summary: 'new footer', diff: '1 file changed', worktree: '/tmp' },
    });
    await until(
      async () =>
        (await api.listRuns({ task: 'approve_general_change', status: 'succeeded' })).length === 1,
    );

    const [gate] = await api.listRuns({ task: 'approve_general_change' });
    expect(gate?.result).toMatchObject({ steps: [{}, { payload: { approved: false } }, null] });
    expect(await publishRuns()).toEqual([]);
  }, 30_000);

  it('publishes nothing after a blocked agent result, and publishes after a done one', async () => {
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);
    const classified = (status: string) => ({
      type: 'email.classified',
      source: 'test',
      payload: {
        kind: 'event_list_update',
        summary: `events ${status}`,
        status,
        email: { from: 'editor@example.com', message_id: '<m1@x>', subject: 'Events' },
      },
    });

    await api.emit(classified('blocked'));
    await until(
      async () => (await api.listRuns({ task: 'reply_blocked', status: 'succeeded' })).length === 1,
    );
    expect(await publishRuns()).toEqual([]);

    await api.emit(classified('done'));
    await until(
      async () => (await api.listRuns({ task: 'publish_site', status: 'succeeded' })).length === 1,
    );
    expect(await publishRuns()).toHaveLength(1);
  }, 30_000);
});

describe('reply_blocked from the example', () => {
  it('replies to the sender with what is missing', async () => {
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);

    await api.emit({
      type: 'site.change_blocked',
      source: 'test',
      payload: {
        summary: 'need dates',
        missing: ['dates', 'venue'],
        email: { from: 'editor@example.com', message_id: '<m1@x>', subject: 'Events' },
      },
    });
    await until(async () => (await api.listRuns({ task: 'reply_blocked' })).length === 1);
    await daemon.core.executor.idle();

    const [run] = await api.listRuns({ task: 'reply_blocked' });
    expect(run, run?.error ?? '').toMatchObject({ status: 'succeeded' });
    expect((await api.getState('email', 'sent'))?.value).toEqual([
      expect.objectContaining({
        to: 'editor@example.com',
        in_reply_to: '<m1@x>',
        subject: 'Re: Events',
        text: expect.stringMatching(
          /could not apply this change to the website yet: need dates\n\nPlease send: dates, venue/,
        ) as string,
      }),
    ]);
  }, 30_000);
});

describe('ftp inbox import on the fake connector', () => {
  it('lists, fans files out, reads and moves each one exactly once', async () => {
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);

    const first = await api.run('scan_incoming');
    await until(
      async () => (await api.listRuns({ task: 'import_file', status: 'succeeded' })).length === 1,
    );
    await daemon.core.executor.idle();
    expect((await api.getRun(first.run.id)).result).toMatchObject({
      path: 'incoming',
      truncated: false,
      entries: [
        { name: 'notes', path: 'incoming/notes', type: 'dir' },
        { name: 'orders.csv', path: 'incoming/orders.csv', type: 'file', size: 10 },
      ],
    });
    const imported = daemon.core.store.events
      .listAfter(0, 1000)
      .filter((e) => e.type === 'ftp.file_imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.payload).toEqual({
      name: 'orders.csv',
      content: 'id;qty|1;2',
      moved_to: 'processed/orders.csv',
    });

    // The file moved, so a second scan sees nothing to import; the directory is skipped.
    const again = await api.run('scan_incoming');
    await until(async () => (await api.getRun(again.run.id)).status === 'succeeded');
    await daemon.core.executor.idle();
    expect((await api.getRun(again.run.id)).result).toMatchObject({
      entries: [{ name: 'notes', type: 'dir' }],
    });
    expect(await api.listRuns({ task: 'import_file' })).toHaveLength(1);
  }, 30_000);
});

describe('email_digest from the email example', () => {
  it('sends one digest, advances its cursor and emits email.digest_sent', async () => {
    await until(() => daemon.core.supervisor?.status().every((s) => s.state === 'up') ?? false);

    const first = await api.run('email_digest');
    await until(async () => (await api.getRun(first.run.id)).status !== 'running');
    await daemon.core.executor.idle();
    const run = await api.getRun(first.run.id);
    expect(run, run.error ?? '').toMatchObject({ status: 'succeeded' });
    expect((await api.getState('digest', 'last_uid'))?.value).toBe(2);
    expect((await api.getState('email', 'sent'))?.value).toEqual([
      expect.objectContaining({
        to: ['team@example.com'],
        subject: 'Inbox digest — 2 new',
        text: 'Spring event\nBuy now\n',
      }),
    ]);
    const sent = () =>
      daemon.core.store.events.listAfter(0, 1000).filter((e) => e.type === 'email.digest_sent');
    expect(sent().map((e) => e.payload)).toEqual([{ count: 2, last_uid: 2 }]);

    // Nothing new on the next run: no mail, no event, and the run still succeeds.
    const again = await api.run('email_digest');
    await until(async () => (await api.getRun(again.run.id)).status !== 'running');
    await daemon.core.executor.idle();
    const second = await api.getRun(again.run.id);
    expect(second, second.error ?? '').toMatchObject({ status: 'succeeded' });
    expect((await api.getState('email', 'sent'))?.value).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    expect((await api.getState('digest', 'last_uid'))?.value).toBe(2);
  }, 30_000);
});
