import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionRunner, ActionRunners } from './actions/types.js';
import { taskSource } from './bus/matcher.js';
import { ConfigLoadError, createCore, type Core } from './core.js';
import { createLogger } from './log.js';

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

const EXAMPLE = new URL('../../../docs/examples/orchestra-website.yaml', import.meta.url).pathname;

let dir: string;
let core: Core;
let lines: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-core-'));
  writeFileSync(join(dir, 'tasks.yaml'), readFileSync(EXAMPLE));
  lines = [];
  core = createCore({
    tasksFile: join(dir, 'tasks.yaml'),
    dbPath: join(dir, 'state.db'),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    runners: hangAll,
  });
  core.start();
});

afterEach(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const started = () => core.store.runs.listByStatus('running').map((r) => r.task);

describe('createCore with the reference workflow', () => {
  it('arms the cron task and loads all seven tasks', () => {
    expect(core.config().tasks.map((t) => t.name)).toEqual([
      'fetch_email',
      'classify_orchestra_email',
      'update_event_list',
      'update_site_general',
      'approve_general_change',
      'publish_site',
      'notify',
    ]);
    expect(core.scheduler.list().map((j) => j.task)).toEqual(['fetch_email']);
    expect(lines.find((l) => l.msg === 'core.started')).toMatchObject({ backlog_runs: 0 });
  });

  it("queues exactly one classification run for the orchestrator's mail and none for others", () => {
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { from: 'orchestrator@example.cz', subject: 'Concert', body: '…' },
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
      payload: { from: 'orchestrator@example.cz', subject: 'dup', body: '…' },
    });
    core.bus.dispatcher.drain();
    expect(started()).toEqual(['classify_orchestra_email']);
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

  it('fans task success out to publish_site by type_any', () => {
    core.bus.publish({
      type: 'task.update_event_list.succeeded',
      source: taskSource('update_event_list'),
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

  it('keeps the old config when a reload fails and applies a valid one', () => {
    writeFileSync(join(dir, 'tasks.yaml'), 'tasks: [');
    const bad = core.reload();
    expect(bad.ok).toBe(false);
    expect(core.config().tasks).toHaveLength(7);
    expect(lines.find((l) => l.msg === 'core.config_invalid')).toBeDefined();

    writeFileSync(
      join(dir, 'tasks.yaml'),
      'tasks:\n  - name: only\n    trigger: { kind: cron, schedule: "0 * * * *" }\n    action: { kind: shell, cmd: ["true"] }\n',
    );
    expect(core.reload().ok).toBe(true);
    expect(core.config().tasks.map((t) => t.name)).toEqual(['only']);
    expect(core.scheduler.list().map((j) => j.task)).toEqual(['only']);
  });

  it('dispatches a backlog left from before a restart', async () => {
    core.bus.publish({
      type: 'task.update_event_list.succeeded',
      source: taskSource('update_event_list'),
    });
    await core.stop(); // before the wake ran
    core = createCore({
      tasksFile: join(dir, 'tasks.yaml'),
      dbPath: join(dir, 'state.db'),
      log: createLogger({ sink: () => undefined }),
      runners: hangAll,
    });
    core.start();
    expect(started()).toEqual(['publish_site']);
  });

  it('refuses to start on invalid config', async () => {
    writeFileSync(
      join(dir, 'bad.yaml'),
      'tasks:\n  - name: a\n    trigger: { kind: cron, schedule: nope }\n    action: { kind: shell, cmd: ["true"] }\n',
    );
    const broken = createCore({
      tasksFile: join(dir, 'bad.yaml'),
      dbPath: join(dir, 'other.db'),
      log: createLogger({ sink: () => undefined }),
    });
    expect(() => {
      broken.start();
    }).toThrow(ConfigLoadError);
    await broken.stop();
  });
});
