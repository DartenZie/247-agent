import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionRunner, ActionRunners } from './actions/types.js';
import { taskSource } from './bus/matcher.js';
import { ConfigLoadError, createCore, type Core } from './core.js';
import { createLogger } from './log.js';
import { staticSecrets } from './secrets/secrets.js';

/** Runs stay `running` until the core stops, so these tests see what was dispatched. */
const hang: ActionRunner = (_a, ctx) =>
  new Promise((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      reject(ctx.signal.reason as Error);
    });
  });
const hangAll: ActionRunners = {
  shell: hang,
  connector: hang,
  llm: hang,
  agent: hang,
  wait: hang,
  sequence: hang,
};

const EXAMPLE = new URL('../../../docs/examples/website-updates.yaml', import.meta.url).pathname;

let dir: string;
let core: Core;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-core-'));
  writeFileSync(join(dir, 'tasks.yaml'), readFileSync(EXAMPLE));
  lines = [];
  core = createCore({
    tasksFiles: [join(dir, 'tasks.yaml')],
    dbPath: join(dir, 'state.db'),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    runners: hangAll,
    secrets: staticSecrets({ ftp_pass: 'x' }),
  });
  await core.start();
});

afterEach(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const started = () => core.store.runs.listByStatus('running').map((r) => r.task);

describe('createCore with the reference workflow', () => {
  it('arms the cron task and loads all nine tasks', () => {
    expect(core.config().tasks.map((t) => t.name)).toEqual([
      'fetch_email',
      'classify_email',
      'update_event_list',
      'push_event_list',
      'reply_blocked',
      'update_site_general',
      'approve_general_change',
      'publish_site',
      'notify',
    ]);
    expect(core.scheduler.list().map((j) => j.task)).toEqual(['fetch_email']);
    expect(lines.find((l) => l.msg === 'core.started')).toMatchObject({ backlog_runs: 0 });
  });

  it("queues exactly one classification run for the trusted sender's mail and none for others", () => {
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { from: 'editor@example.com', subject: 'Event', body: '…' },
    });
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:2',
      payload: { from: 'newsletter@example.com', subject: 'Sale', body: '…' },
    });
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { from: 'editor@example.com', subject: 'dup', body: '…' },
    });
    core.bus.dispatcher.drain();
    expect(started()).toEqual(['classify_email']);
  });

  it('routes failures to notify except failures of notify itself, keeping the correlation id', () => {
    const root = core.bus.publish({
      type: 'email.received',
      source: 'email',
      payload: { from: 'x' },
    });
    if (root.status !== 'inserted') {
      throw new Error('unexpected');
    }
    core.bus.publish({
      type: 'task.publish_site.failed',
      source: taskSource('publish_site'),
      parent_id: root.event.id,
      payload: { error: 'lftp exited 1' },
    });
    core.bus.publish({
      type: 'task.notify.failed',
      source: taskSource('notify'),
      parent_id: root.event.id,
      payload: { error: 'chat down' },
    });
    core.bus.dispatcher.drain();
    const runs = core.store.runs.listByStatus('running');
    expect(runs.map((r) => r.task)).toEqual(['notify']);
    expect(runs[0]?.correlation_id).toBe(root.event.correlation_id);
  });

  it('publishes a pushed change, not a bare task success', () => {
    core.bus.publish({
      type: 'task.push_event_list.succeeded',
      source: taskSource('push_event_list'),
    });
    core.bus.dispatcher.drain();
    expect(started()).toEqual([]);
    core.bus.publish({
      type: 'site.change_pushed',
      source: taskSource('push_event_list'),
    });
    core.bus.dispatcher.drain();
    expect(started()).toEqual(['publish_site']);
  });

  it('runs any task manually', () => {
    const { run } = core.runTask('publish_site');
    expect(run.task).toBe('publish_site');
    expect(core.store.runs.getById(run.id)?.status).toBe('running');
    expect(() => core.runTask('nope')).toThrow(/unknown task/);
  });

  it('keeps the old config when a reload fails and applies a valid one', async () => {
    writeFileSync(join(dir, 'tasks.yaml'), 'tasks: [');
    const bad = await core.reload();
    expect(bad.ok).toBe(false);
    expect(core.config().tasks).toHaveLength(9);
    expect(lines.filter((l) => l.msg === 'core.config_invalid')).toEqual([
      expect.objectContaining({
        level: 'error',
        file: join(dir, 'tasks.yaml'),
        path: '',
        issue: expect.stringMatching(/^YAML syntax error/) as string,
      }),
    ]);

    writeFileSync(
      join(dir, 'tasks.yaml'),
      'tasks:\n  - name: only\n    trigger: { kind: cron, schedule: "0 * * * *" }\n    action: { kind: shell, cmd: ["true"] }\n',
    );
    expect((await core.reload()).ok).toBe(true);
    expect(core.config().tasks.map((t) => t.name)).toEqual(['only']);
    expect(core.scheduler.list().map((j) => j.task)).toEqual(['only']);
  });

  it('logs what oa validate warns about at start and on every reload, without failing', async () => {
    expect(lines.filter((l) => l.msg === 'core.config_warning')).toEqual([]);
    const file = join(dir, 'tasks.yaml');
    writeFileSync(
      file,
      [
        'tasks:',
        '  - name: gate',
        '    trigger: { kind: event, type: approval.answered, filter: "payload.approved == true" }',
        '    action: { kind: shell, cmd: ["true"] }',
      ].join('\n'),
    );
    const warning = {
      level: 'warn',
      msg: 'core.config_warning',
      task: 'gate',
      file,
      path: 'tasks[0].trigger.filter',
      warning:
        'payload.approved == true: true here is a field named "true", not the literal; write `true`',
    };
    expect((await core.reload()).ok).toBe(true);
    expect(core.config().tasks.map((t) => t.name)).toEqual(['gate']);
    expect(lines.filter((l) => l.msg === 'core.config_warning')).toEqual([
      expect.objectContaining(warning),
    ]);

    const startLines: Record<string, unknown>[] = [];
    const second = createCore({
      tasksFiles: [file],
      dbPath: join(dir, 'second.db'),
      log: createLogger({
        level: 'debug',
        sink: (l) => startLines.push(JSON.parse(l) as Record<string, unknown>),
      }),
      runners: hangAll,
    });
    await second.start();
    await second.stop();
    expect(startLines.filter((l) => l.msg === 'core.config_warning')).toEqual([
      expect.objectContaining(warning),
    ]);
  });

  it('dispatches a backlog left from before a restart', async () => {
    core.bus.publish({
      type: 'site.change_pushed',
      source: taskSource('push_event_list'),
    });
    await core.stop(); // before the wake ran
    core = createCore({
      tasksFiles: [join(dir, 'tasks.yaml')],
      dbPath: join(dir, 'state.db'),
      log: createLogger({ sink: () => undefined }),
      runners: hangAll,
      secrets: staticSecrets({ ftp_pass: 'x' }),
    });
    await core.start();
    expect(started()).toEqual(['publish_site']);
  });

  it('publishes a change pushed just before a restart', async () => {
    // A fake `main`: the agent and the shell runner push to it as the example's argv say,
    // and a push hangs until the core stops, as if the daemon died right after it.
    const main = { changed: false };
    let dying = true;
    const isPush = (argv: unknown) => Array.isArray(argv) && argv.join(' ').includes('git push');
    const push = (ctx: Parameters<ActionRunner>[1]) => {
      main.changed = true;
      return dying ? hang(undefined, ctx) : Promise.resolve('');
    };
    const runners: ActionRunners = {
      ...hangAll,
      connector: () => Promise.resolve(null),
      // A fresh worktree from `main` already has a pushed change: nothing to commit.
      agent: async (action, ctx) => {
        for (const gate of (action as { post?: { shell: string[] }[] }).post ?? []) {
          if (gate.shell.includes('commit') && main.changed) {
            throw new Error('post[1] (git commit) failed: nothing to commit');
          }
          if (isPush(gate.shell)) {
            await push(ctx);
          }
        }
        return { status: 'done', summary: 'spring event' };
      },
      shell: (action, ctx) =>
        isPush((action as { cmd: unknown }).cmd) ? push(ctx) : Promise.resolve(''),
    };
    const boot = async () => {
      await core.stop();
      core = createCore({
        tasksFiles: [join(dir, 'tasks.yaml')],
        dbPath: join(dir, 'state.db'),
        log: createLogger({ sink: () => undefined }),
        runners,
        secrets: staticSecrets({ ftp_pass: 'x' }),
      });
      await core.start();
    };
    await boot();
    core.bus.publish({
      type: 'email.classified',
      source: 'test',
      payload: { kind: 'event_list_update', summary: 'spring event', email: {} },
    });
    for (let i = 0; i < 100 && !main.changed; i++) {
      core.bus.dispatcher.drain();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(main.changed).toBe(true);

    dying = false;
    await boot();
    for (let i = 0; i < 5; i++) {
      core.bus.dispatcher.drain();
      await core.executor.idle();
    }
    expect(core.store.runs.listByStatus('succeeded').map((r) => r.task)).toContain('publish_site');
    const pushed = core.store.events
      .listAfter(0, 100)
      .filter((e) => e.type === 'site.change_pushed');
    expect(pushed).toHaveLength(1);
  });

  it('refuses to start on invalid config', async () => {
    writeFileSync(
      join(dir, 'bad.yaml'),
      'tasks:\n  - name: a\n    trigger: { kind: cron, schedule: nope }\n    action: { kind: shell, cmd: ["true"] }\n',
    );
    const broken = createCore({
      tasksFiles: [join(dir, 'bad.yaml')],
      dbPath: join(dir, 'other.db'),
      log: createLogger({ sink: () => undefined }),
    });
    await expect(broken.start()).rejects.toThrow(ConfigLoadError);
    await broken.stop();
  });
});
