import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BwrapProbeResult } from './actions/bwrap-probe.js';
import type { SandboxConfig } from './actions/sandbox.js';
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

/** The secrets the reference workflow names. */
const SECRETS = { ftp_user: 'deploy', ftp_pass: 'x' };

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
    secrets: staticSecrets(SECRETS),
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

  it('sets every variable the publish command reads, the SFTP user from a secret', () => {
    const publish = core.config().tasks.find((t) => t.name === 'publish_site');
    const action = publish?.config.action as { cmd: string[]; env?: Record<string, string> };
    const read = [...action.cmd.join(' ').matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect(read).toContain('FTP_USER');
    for (const name of read) {
      expect(action.env).toHaveProperty([String(name)]);
    }
    expect(action.env?.FTP_USER).toBe('${secrets.ftp_user}');
  });

  it("queues exactly one classification run for the trusted sender's authenticated mail", () => {
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { from: 'editor@example.com', auth: { dmarc: 'pass' }, subject: 'Event', body: '…' },
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
      dedup_key: 'email:3',
      payload: {
        from: 'editor@example.com',
        auth: { dmarc: 'fail' },
        subject: 'Forged',
        body: '…',
      },
    });
    core.bus.publish({
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { from: 'editor@example.com', auth: { dmarc: 'pass' }, subject: 'dup', body: '…' },
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
      'tasks:\n  - name: only\n    trigger: { kind: event, type: x.y, filter: "#TOKEN" }\n    action: { kind: shell, cmd: ["true"] }\n',
    );
    expect((await core.reload()).ok).toBe(false);
    expect(lines.filter((l) => l.msg === 'core.config_invalid').at(-1)).toMatchObject({
      file: join(dir, 'tasks.yaml'),
      path: 'tasks[0].trigger.filter',
      task: 'only',
      line: 3,
    });

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
      secrets: staticSecrets(SECRETS),
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
        secrets: staticSecrets(SECRETS),
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

describe('createCore with an event loop', () => {
  it('stops a two-way fan-out loop at the chain cap and tells a notifier once', async () => {
    const loopDir = mkdtempSync(join(tmpdir(), 'oa-loop-'));
    const file = join(loopDir, 'tasks.yaml');
    const fanOut = (type: string) => [
      '    action: { kind: shell, cmd: ["true"] }',
      '    emit:',
      `      - { type: ${type}, each: "\${\`[1, 2]\`}" }`,
    ];
    writeFileSync(
      file,
      [
        'tasks:',
        '  - name: ping',
        '    trigger: { kind: event, type: x.ping }',
        ...fanOut('x.pong'),
        '  - name: pong',
        '    trigger: { kind: event, type: x.pong }',
        ...fanOut('x.ping'),
        '  - name: alert',
        '    trigger: { kind: event, type: loop.detected }',
        '    action: { kind: shell, cmd: ["true"] }',
      ].join('\n'),
    );
    const loopLines: Record<string, unknown>[] = [];
    const succeed: ActionRunner = () => Promise.resolve({ ok: true });
    const looping = createCore({
      tasksFiles: [file],
      dbPath: join(loopDir, 'state.db'),
      log: createLogger({
        level: 'debug',
        sink: (l) => loopLines.push(JSON.parse(l) as Record<string, unknown>),
      }),
      runners: { ...hangAll, shell: succeed },
      maxChainRuns: 20,
    });
    await looping.start();
    try {
      expect(loopLines.filter((l) => l.msg === 'core.config_warning')).toEqual([
        expect.objectContaining({
          task: 'ping',
          path: 'tasks[0].trigger',
          warning: expect.stringContaining(
            'event cycle: ping emits "x.pong" to pong, pong emits "x.ping" to ping;',
          ) as unknown,
        }),
      ]);
      looping.bus.publish({ type: 'x.ping', source: 'test' });
      const runs = (task: string) =>
        (['queued', 'running', 'succeeded'] as const).flatMap((s) =>
          looping.store.runs.listByStatus(s).filter((r) => r.task === task),
        );
      await expect
        .poll(() => runs('alert').filter((r) => r.status === 'succeeded'), { timeout: 5000 })
        .toHaveLength(1);
      await expect
        .poll(
          () =>
            looping.store.runs.listByStatus('queued').length +
            looping.store.runs.listByStatus('running').length,
        )
        .toBe(0);
      expect(runs('ping').length + runs('pong').length).toBe(20);
      expect(looping.store.events.list({ type: 'loop.detected' })).toHaveLength(1);
      expect(looping.metrics.render()).toMatch(
        /oa_events_published_total\{type="loop.detected",result="inserted"\} 1/,
      );
      expect(looping.metrics.render()).not.toMatch(
        /oa_events_published_total\{type="loop.detected",result="duplicate"\}/,
      );
    } finally {
      await looping.stop();
      rmSync(loopDir, { recursive: true, force: true });
    }
  });
});

describe('createCore checks bubblewrap when something is sandboxed', () => {
  const boxed = [
    'tasks:',
    '  - name: boxed',
    '    trigger: { kind: manual }',
    '    action: { kind: shell, cmd: ["true"], sandbox: bwrap }',
  ].join('\n');
  const plain = [
    'tasks:',
    '  - name: plain',
    '    trigger: { kind: manual }',
    '    action: { kind: shell, cmd: ["true"] }',
  ].join('\n');

  const startWith = async (
    tasks: string,
    result: BwrapProbeResult,
    extra: { defaultSandbox?: SandboxConfig } = {},
  ) => {
    const file = join(dir, 'boxed.yaml');
    writeFileSync(file, tasks);
    const out: Record<string, unknown>[] = [];
    let probes = 0;
    const c = createCore({
      tasksFiles: [file],
      dbPath: join(dir, 'boxed.db'),
      log: createLogger({
        level: 'debug',
        sink: (l) => out.push(JSON.parse(l) as Record<string, unknown>),
      }),
      runners: hangAll,
      bwrapProbe: () => {
        probes += 1;
        return Promise.resolve(result);
      },
      ...extra,
    });
    await c.start();
    return { c, out, file, probes: () => probes };
  };
  const unavailable = (out: Record<string, unknown>[]) =>
    out.filter((l) => l.msg === 'core.sandbox_unavailable');
  const cause = 'bwrap cannot start a sandbox (bwrap: setting up uid map: Permission denied)';

  it('warns at start with the cause and what is sandboxed, and starts anyway', async () => {
    const { c, out } = await startWith(boxed, { ok: false, cause });
    try {
      expect(unavailable(out)).toEqual([
        expect.objectContaining({ level: 'warn', cause, used_by: 'task boxed' }),
      ]);
      expect(out.some((l) => l.msg === 'core.started')).toBe(true);
    } finally {
      await c.stop();
    }
  });

  it('counts defaults.sandbox', async () => {
    const { c, out } = await startWith(
      plain,
      { ok: false, cause },
      { defaultSandbox: { backend: 'bwrap', extra_args: [], ro_binds: [], rw_binds: [] } },
    );
    try {
      expect(unavailable(out)).toEqual([expect.objectContaining({ used_by: 'task plain' })]);
    } finally {
      await c.stop();
    }
  });

  it('does not probe when nothing uses bwrap, and stays quiet when bwrap works', async () => {
    const none = await startWith(plain, { ok: false, cause });
    await none.c.stop();
    expect(none.probes()).toBe(0);
    expect(unavailable(none.out)).toEqual([]);

    const works = await startWith(boxed, { ok: true });
    await works.c.stop();
    expect(works.probes()).toBe(1);
    expect(unavailable(works.out)).toEqual([]);
  });

  it('probes again on a reload that adds a sandbox', async () => {
    const { c, out, file, probes } = await startWith(plain, { ok: false, cause });
    try {
      expect(probes()).toBe(0);
      writeFileSync(file, boxed);
      expect((await c.reload()).ok).toBe(true);
      expect(probes()).toBe(1);
      expect(unavailable(out)).toEqual([expect.objectContaining({ used_by: 'task boxed' })]);
    } finally {
      await c.stop();
    }
  });
});
