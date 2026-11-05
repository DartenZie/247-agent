import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BwrapProbeResult } from './actions/bwrap-probe.js';
import type { SandboxConfig } from './actions/sandbox.js';
import type { ActionRunner, ActionRunners } from './actions/types.js';
import { taskSource } from './bus/matcher.js';
import { parseManifest, type ConnectorConfig } from './config/connector.js';
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

  it('logs a warning for an agent granted a connector whose manifest has no ops', async () => {
    const file = join(dir, 'agent-tasks.yaml');
    writeFileSync(
      file,
      [
        'tasks:',
        '  - name: edit',
        '    trigger: { kind: manual }',
        '    action:',
        '      kind: agent',
        '      workspace: { kind: temp }',
        '      tools: [read]',
        '      prompt: x',
        '      mcp_servers: [github]',
      ].join('\n'),
    );
    const github = parseManifest(
      { name: 'github', exec: ['node', '-e', 'setInterval(() => undefined, 60000)'] },
      '/x/connectors.d/github.yaml',
    );
    if (!github.ok) {
      throw new Error(JSON.stringify(github.issues));
    }
    const out: Record<string, unknown>[] = [];
    const c = createCore({
      tasksFiles: [file],
      dbPath: join(dir, 'agent.db'),
      socketPath: join(dir, 'a.sock'),
      connectors: [github.config],
      log: createLogger({
        level: 'debug',
        sink: (l) => out.push(JSON.parse(l) as Record<string, unknown>),
      }),
      runners: hangAll,
    });
    await c.start();
    await c.stop();
    expect(out.filter((l) => l.msg === 'core.config_warning')).toEqual([
      expect.objectContaining({
        level: 'warn',
        task: 'edit',
        file,
        path: 'tasks[0].action.mcp_servers[0]',
        line: 9,
        warning: expect.stringMatching(
          /^connector "github" \(\/x\/connectors\.d\/github\.yaml\) has no ops in its manifest/,
        ) as string,
      }),
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

describe('createCore exposes health metrics (#90)', () => {
  const TASKS = [
    'fetch_email',
    'classify_email',
    'update_event_list',
    'push_event_list',
    'reply_blocked',
    'update_site_general',
    'approve_general_change',
    'publish_site',
    'notify',
  ];
  const sample = (text: string, series: string): number | undefined => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line === undefined ? undefined : Number(line.slice(series.length + 1));
  };
  let n = 0;
  const event = (ts = new Date().toISOString()) => {
    n += 1;
    const id = `evt_metrics_${String(n)}`;
    core.store.events.insert({
      id,
      type: 'x.unmatched',
      source: 'test',
      ts,
      correlation_id: id,
      parent_id: null,
      dedup_key: null,
      depth: 0,
      payload: {},
    });
    return id;
  };

  it('renders run counters at 0 for every configured task and status from startup', () => {
    const text = core.metrics.render();
    expect(sample(text, 'oa_dispatch_failures_total')).toBe(0);
    for (const task of TASKS) {
      for (const status of ['succeeded', 'failed', 'cancelled']) {
        expect(sample(text, `oa_runs_finished_total{task="${task}",status="${status}"}`)).toBe(0);
      }
      expect(sample(text, `oa_runs_queued_total{task="${task}"}`)).toBe(0);
      expect(sample(text, `oa_run_attempts_total{task="${task}"}`)).toBe(0);
      expect(sample(text, `oa_runs_interrupted_total{task="${task}"}`)).toBe(0);
      expect(sample(text, `oa_runs_adopted_total{task="${task}"}`)).toBe(0);
    }
  });

  it('reports undispatched events and the oldest queued run', () => {
    let text = core.metrics.render();
    expect(sample(text, 'oa_events_undispatched')).toBe(0);
    expect(sample(text, 'oa_runs_oldest_pending_age_seconds')).toBe(0);

    const queued = event();
    core.store.runs.insertQueued({
      id: 'run_old',
      task: 'publish_site',
      event_id: queued,
      correlation_id: queued,
      created_at: new Date(Date.now() - 90_000).toISOString(),
    });
    event();
    event();

    text = core.metrics.render();
    expect(sample(text, 'oa_events_undispatched')).toBe(3);
    const age = sample(text, 'oa_runs_oldest_pending_age_seconds') ?? 0;
    expect(age).toBeGreaterThanOrEqual(90);
    expect(age).toBeLessThan(120);
  });

  it('reports the last success per task, read at start and kept by each run that succeeds', async () => {
    const last = (task: string) =>
      sample(core.metrics.render(), `oa_task_last_success_timestamp_seconds{task="${task}"}`);
    expect(core.metrics.render()).not.toContain('oa_task_last_success_timestamp_seconds{');
    const done = event();
    core.store.runs.insertQueued({
      id: 'run_done',
      task: 'notify',
      event_id: done,
      correlation_id: done,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    core.store.runs.setStatus('run_done', 'succeeded', {
      finished_at: '2026-01-02T03:04:05.000Z',
    });
    // A scrape reads no runs: a row written behind the executor shows only after a restart.
    expect(last('notify')).toBeUndefined();
    await core.stop();
    const succeed: ActionRunner = () => Promise.resolve({ ok: true });
    core = createCore({
      tasksFiles: [join(dir, 'tasks.yaml')],
      dbPath: join(dir, 'state.db'),
      log: createLogger({ sink: () => undefined }),
      runners: { ...hangAll, shell: succeed },
      secrets: staticSecrets(SECRETS),
    });
    await core.start();
    expect(last('notify')).toBe(Date.parse('2026-01-02T03:04:05.000Z') / 1000);

    const before = Date.now() / 1000;
    core.runTask('publish_site');
    await expect.poll(() => last('publish_site')).toBeGreaterThanOrEqual(before);
  });

  it('reports the write-ahead log and the free disk space next to the database size', () => {
    const text = core.metrics.render();
    expect(sample(text, 'oa_db_wal_size_bytes')).toBe(statSync(join(dir, 'state.db-wal')).size);
    expect(sample(text, 'oa_db_disk_free_bytes')).toBeGreaterThan(0);
  });

  it('counts a run that a stop or a crash cut short when the next start finds it', async () => {
    core.runTask('publish_site');
    await core.stop();
    core = createCore({
      tasksFiles: [join(dir, 'tasks.yaml')],
      dbPath: join(dir, 'state.db'),
      log: createLogger({ sink: () => undefined }),
      runners: hangAll,
      secrets: staticSecrets(SECRETS),
    });
    await core.start();
    expect(sample(core.metrics.render(), 'oa_runs_interrupted_total{task="publish_site"}')).toBe(1);
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

describe('createCore applies a reload all at once (#77)', () => {
  const task = (name: string) =>
    `  - name: ${name}\n    trigger: { kind: manual }\n    action: { kind: shell, cmd: ["true"] }\n`;
  const idle = (): ConnectorConfig => {
    const r = parseManifest(
      { name: 'x', transport: 'none', exec: ['node', '-e', 'setInterval(() => undefined, 60000)'] },
      '/x/connectors.d/x.yaml',
    );
    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }
    return r.config;
  };

  /** One worker, connector `x` supervised, manual tasks `a` and `b`. */
  const startWith = async () => {
    const file = join(dir, 'staged.yaml');
    writeFileSync(file, `tasks:\n${task('a')}${task('b')}`);
    const out: Record<string, unknown>[] = [];
    const c = createCore({
      tasksFiles: [file],
      dbPath: join(dir, 'staged.db'),
      socketPath: join(dir, 'c.sock'),
      connectors: [idle()],
      workers: 1,
      log: createLogger({
        level: 'debug',
        sink: (l) => out.push(JSON.parse(l) as Record<string, unknown>),
      }),
      runners: hangAll,
    });
    await c.start();
    const supervisor = c.supervisor;
    if (supervisor === undefined) {
      throw new Error('no supervisor');
    }
    const real = supervisor.apply.bind(supervisor);
    // The new tasks file: `a`, `b` and a new `c`, applied with two workers and no connector.
    writeFileSync(file, `tasks:\n${task('a')}${task('b')}${task('c')}`);
    return { c, out, supervisor, real };
  };
  const status = (c: Core, id: string) => c.store.runs.getById(id)?.status;

  it('starts no run while connector changes apply, then starts them under the new config', async () => {
    const { c, supervisor, real } = await startWith();
    try {
      let open = (): void => undefined;
      const gate = new Promise<void>((r) => {
        open = r;
      });
      const apply = vi.spyOn(supervisor, 'apply').mockImplementation(async (m) => {
        const applied = real(m);
        await gate;
        return applied;
      });
      const reloading = c.reload({ workers: 2, connectors: [] });
      await vi.waitFor(() => {
        expect(apply).toHaveBeenCalled();
      });

      const a = c.runTask('a').run.id;
      const b = c.runTask('b').run.id;
      expect([status(c, a), status(c, b)]).toEqual(['queued', 'queued']);
      expect(c.config().tasks.map((t) => t.name)).toEqual(['a', 'b']);

      open();
      expect((await reloading).ok).toBe(true);
      expect(c.config().tasks.map((t) => t.name)).toEqual(['a', 'b', 'c']);
      expect([status(c, a), status(c, b)]).toEqual(['running', 'running']);
    } finally {
      await c.stop();
    }
  });

  it('leaves the previous config fully in place when applying connectors fails', async () => {
    const { c, out, supervisor, real } = await startWith();
    try {
      vi.spyOn(supervisor, 'apply').mockImplementationOnce(async (m) => {
        await real(m);
        throw new Error('spawn failed');
      });
      const result = await c.reload({ workers: 2, connectors: [] });
      expect(result).toMatchObject({ ok: false, error: 'spawn failed' });
      expect(out.filter((l) => l.msg === 'core.reload_failed')).toEqual([
        expect.objectContaining({ level: 'error', error: 'spawn failed' }),
      ]);
      expect(c.config().tasks.map((t) => t.name)).toEqual(['a', 'b']);
      expect(supervisor.names()).toEqual(['x']);

      // Still one worker: the second run waits.
      const a = c.runTask('a').run.id;
      const b = c.runTask('b').run.id;
      expect([status(c, a), status(c, b)]).toEqual(['running', 'queued']);
    } finally {
      await c.stop();
    }
  });
});
