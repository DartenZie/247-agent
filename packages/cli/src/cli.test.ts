import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiClient, createLogger, startDaemon, type Daemon } from '@247-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli.js';
import type { Io } from './io.js';

const EXAMPLES = new URL('../../../docs/examples/', import.meta.url).pathname;

const TASKS = `tasks:
  - name: ok
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
  - name: bad
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["false"] }
  - name: hold
    trigger: { kind: manual }
    action: { kind: wait, for: { type: chat.reply } }
`;

let dir: string;
let daemon: Daemon;
let out: string[];
let err: string[];
let stdin = '';
const io: Io = {
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  readStdin: () => Promise.resolve(stdin),
};

const oa = (...args: string[]) => main([...args, '--socket', daemon.config.socket], io);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-cli-'));
  writeFileSync(join(dir, 'tasks.yaml'), TASKS);
  writeFileSync(join(dir, 'agent.yaml'), 'db: state.db\nsocket: core.sock\n');
  daemon = await startDaemon({
    configFile: join(dir, 'agent.yaml'),
    log: createLogger({ sink: () => undefined }),
  });
  out = [];
  err = [];
  stdin = '';
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('oa validate', () => {
  it('validates tasks files and agent files, checking the referenced tasks file', async () => {
    expect(await main(['validate', join(EXAMPLES, 'website-updates.yaml')], io)).toBe(0);
    expect(out).toEqual([`ok ${join(EXAMPLES, 'website-updates.yaml')} (9 tasks)`]);
    out = [];
    expect(await main(['validate', join(EXAMPLES, 'decide-triage.yaml')], io)).toBe(0);
    expect(out).toEqual([`ok ${join(EXAMPLES, 'decide-triage.yaml')} (2 tasks)`]);
    out = [];
    expect(await main(['validate', join(EXAMPLES, 'agent.yaml')], io)).toBe(0);
    expect(out).toHaveLength(12); // agent.yaml, its tasks file, ten connector manifests
    expect(err).toEqual([]);
  });

  it('fails on a bad file and on no file', async () => {
    writeFileSync(join(dir, 'bad.yaml'), 'tasks: []\n');
    expect(await main(['validate', join(dir, 'bad.yaml')], io)).toBe(1);
    expect(err[0]).toMatch(/bad\.yaml:1: tasks: /);
    expect(await main(['validate'], io)).toBe(2);
  });

  it('prints warnings for comparisons that cannot mean what they say, without failing', async () => {
    const file = join(dir, 'warn.yaml');
    writeFileSync(
      file,
      [
        'tasks:',
        '  - name: gate',
        '    trigger: { kind: event, type: approval.answered, filter: "payload.approved == true" }',
        '    action: { kind: shell, cmd: ["true"] }',
      ].join('\n'),
    );
    expect(await main(['validate', file], io)).toBe(0);
    expect(out).toEqual([`ok ${file} (1 tasks)`]);
    expect(err).toEqual([
      `${file}:3: tasks[0].trigger.filter: warning: task "gate": payload.approved == true: true here is a field named "true", not the literal; write \`true\``,
    ]);
  });
});

describe('oa run', () => {
  it('queues a run and prints its id', async () => {
    expect(await oa('run', 'ok')).toBe(0);
    expect(out[0]).toMatch(/^queued run_\w+ for ok \(event evt_\w+\)$/);
  });

  it('passes the event file and --type through and waits for the result', async () => {
    writeFileSync(join(dir, 'ev.json'), '{"type": "x.y", "payload": {"n": 1}}');
    expect(
      await oa('run', 'ok', '--event', join(dir, 'ev.json'), '--type', 'z.z', '--wait', '--json'),
    ).toBe(0);
    const res = JSON.parse(out[0] ?? '') as { event_id: string; run: { status: string } };
    expect(res.run.status).toBe('succeeded');
    const trigger = daemon.core.store.events.getById(res.event_id);
    expect(trigger?.payload).toEqual({ task: 'ok', event: { type: 'z.z', payload: { n: 1 } } });
  });

  it('reads the event from stdin and exits 1 when the awaited run fails', async () => {
    stdin = '{"payload": [1, 2]}';
    expect(await oa('run', 'bad', '--event', '-', '--wait')).toBe(1);
    expect(out[0]).toMatch(/^failed run_\w+ for bad: /);
  });

  it('rejects unknown tasks, malformed event files and bad flags', async () => {
    expect(await oa('run', 'nope')).toBe(1);
    expect(err[0]).toMatch(/unknown task "nope"/);
    writeFileSync(join(dir, 'ev.json'), '{"payload": 1, "extra": 2}');
    expect(await oa('run', 'ok', '--event', join(dir, 'ev.json'))).toBe(2);
    expect(err.at(-2)).toMatch(/unknown key "extra"/);
    expect(await oa('run', 'ok', '--bogus')).toBe(2);
    expect(await oa('run')).toBe(2);
  });

  it('explains an unreachable daemon', async () => {
    expect(await main(['run', 'ok', '--socket', join(dir, 'none.sock')], io)).toBe(1);
    expect(err[0]).toMatch(/cannot connect to the daemon .* Is 247-agent-core running\?/);
  });
});

describe('oa emit', () => {
  it('publishes with the given payload and flags and reports duplicates', async () => {
    writeFileSync(join(dir, 'p.json'), '{"hello": "world"}');
    expect(
      await oa('emit', 'chat.reply', join(dir, 'p.json'), '--dedup-key', 'k1', '--source', 'chat'),
    ).toBe(0);
    expect(out[0]).toMatch(/^inserted evt_\w+ type=chat.reply correlation=cor_\w+$/);
    const id = /inserted (evt_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    expect(daemon.core.store.events.getById(id)).toMatchObject({
      source: 'chat',
      dedup_key: 'k1',
      payload: { hello: 'world' },
    });
    expect(await oa('emit', 'chat.reply', '--dedup-key', 'k1')).toBe(0);
    expect(out[1]).toBe('duplicate dedup_key=k1');
  });

  it('defaults to a null payload and source manual, and supports --json and --parent', async () => {
    expect(await oa('emit', 'a.b', '--json')).toBe(0);
    const first = JSON.parse(out[0] ?? '') as { event: { id: string; correlation_id: string } };
    expect(daemon.core.store.events.getById(first.event.id)).toMatchObject({
      source: 'manual',
      payload: null,
    });
    expect(await oa('emit', 'a.c', '--parent', first.event.id, '--json')).toBe(0);
    expect(JSON.parse(out[1] ?? '')).toMatchObject({
      event: { parent_id: first.event.id, correlation_id: first.event.correlation_id, depth: 1 },
    });
  });

  it('rejects invalid types and payloads', async () => {
    expect(await oa('emit', 'Not Valid')).toBe(2);
    expect(err[0]).toMatch(/invalid event type/);
    stdin = '{oops';
    expect(await oa('emit', 'a.b', '-')).toBe(2);
    expect(err.at(-2)).toMatch(/stdin: invalid JSON/);
  });
});

describe('oa runs', () => {
  it('lists runs newest first with filters, shows one with its event and cost, and rejects bad input', async () => {
    expect(await oa('runs', 'ls')).toBe(0);
    expect(out).toEqual(['no runs']);
    out = [];
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    expect(await oa('run', 'bad', '--wait')).toBe(1);
    const okId = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    const badId = /^failed (run_\w+)/.exec(out[2] ?? '')?.[1] ?? '';
    out = [];
    expect(await oa('runs', 'ls')).toBe(0);
    expect(out[0]).toMatch(new RegExp(`^${badId}  bad  failed     \\S+  +[\\d.]+s  .*exit`));
    expect(out[1]).toMatch(new RegExp(`^${okId}  ok   succeeded  \\S+  +[\\d.]+s$`));
    out = [];
    expect(await oa('runs', 'ls', '--status', 'failed', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ runs: [{ id: badId, status: 'failed' }] });
    out = [];
    expect(await oa('runs', 'ls', '--task', 'ok', '-n', '1')).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(okId);
    out = [];

    daemon.core.store.ledger.insert({
      run_id: okId,
      task: 'ok',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      in_tok: 100,
      out_tok: 20,
      cache_read: 0,
      cache_write: 0,
      usd: 0.0123,
      priced_by: 'table',
      ts: '2026-09-29T10:00:00.000Z',
    });
    expect(await oa('runs', 'show', okId)).toBe(0);
    expect(out[0]).toBe(`run         ${okId}`);
    expect(out[1]).toBe('task        ok');
    expect(out[2]).toBe('status      succeeded');
    expect(out[3]).toMatch(
      /^event {7}\S+ {2}evt_\w+ {2}manual\.run {2}source=manual {2}correlation=cor_\w+$/,
    );
    expect(out[4]).toMatch(/^payload {5}\{"task":"ok"/);
    expect(out.find((l) => l.startsWith('cost'))).toBe('cost        $0.0123 in 1 call');
    expect(out.find((l) => l.includes('anthropic/claude-haiku-4-5'))).toMatch(
      /\$0\.0123 \(table\)$/,
    );
    expect(out.find((l) => l.startsWith('transcript'))).toBeUndefined();
    expect(out.at(-1)).toBe('result      ""');
    out = [];
    expect(await oa('runs', 'show', badId)).toBe(1);
    expect(out.find((l) => l.startsWith('error'))).toMatch(/^error {7}.*exit/);
    out = [];
    expect(await oa('runs', 'show', badId, '--json')).toBe(1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      run: { id: badId },
      event: { type: 'manual.run' },
      ledger: { total_usd: 0 },
      has_transcript: false,
    });

    expect(await oa('runs', 'show', 'run_nope')).toBe(1);
    expect(err[0]).toMatch(/unknown run "run_nope"/);
    expect(await oa('runs', 'ls', '--status', 'weird')).toBe(2);
    expect(await oa('runs', 'ls', '-n', '0')).toBe(2);
    expect(await oa('runs', 'show')).toBe(2);
    expect(await oa('runs', 'frob')).toBe(2);
    expect(await oa('runs')).toBe(2);
  });

  it('prints a transcript as lines or JSON, follows a run to its end, and says when there is none', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    const id = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    out = [];
    expect(await oa('runs', 'logs', id, '--follow')).toBe(0);
    expect(out).toEqual([
      `no output for ${id} (ok, succeeded): it printed nothing and has no agent transcript`,
    ]);
    out = [];

    const base = { run_id: id, ts: '2026-09-29T10:00:00.000Z', turn: 1 as const };
    const rows = [
      { kind: 'prompt' as const, text: 'Change the banner.\nKeep it short.', data: null },
      {
        kind: 'tool_call' as const,
        text: null,
        data: {
          id: 'c1',
          title: 'Run build',
          tool_kind: 'execute',
          status: 'pending',
          command: 'npm run build',
          locations: [],
        },
      },
      {
        kind: 'permission' as const,
        text: null,
        data: { id: 'c1', allowed: false, option_id: 'n', reason: 'command not allowed' },
      },
      { kind: 'tool_call_update' as const, text: null, data: { id: 'c1', status: 'failed' } },
      { kind: 'text' as const, text: 'Done.', data: null },
      { kind: 'usage' as const, text: null, data: { used: 500, size: 200000, cost_usd: 0.02 } },
      {
        kind: 'stop' as const,
        text: null,
        data: { stop_reason: 'end_turn', input_tokens: 10, output_tokens: 2 },
      },
      { kind: 'result' as const, text: null, data: { status: 'blocked', summary: 'no build' } },
    ];
    const ids = rows.map((r) => daemon.core.store.transcripts.append({ ...base, ...r }));
    expect(await oa('runs', 'logs', id)).toBe(0);
    expect(out).toEqual([
      '2026-09-29T10:00:00.000Z  turn 1  prompt',
      '    Change the banner.',
      '    Keep it short.',
      '2026-09-29T10:00:00.000Z  turn 1  tool_call  c1  execute  "Run build"  cmd="npm run build"  pending',
      '2026-09-29T10:00:00.000Z  turn 1  permission  c1  refused  command not allowed',
      '2026-09-29T10:00:00.000Z  turn 1  tool_call_update  c1  failed',
      '2026-09-29T10:00:00.000Z  turn 1  text',
      '    Done.',
      '2026-09-29T10:00:00.000Z  turn 1  usage  context=500/200000  cost_usd=0.0200',
      '2026-09-29T10:00:00.000Z  turn 1  stop  end_turn  in=10  out=2',
      '2026-09-29T10:00:00.000Z  turn 1  result  blocked  "no build"',
    ]);
    out = [];
    expect(await oa('runs', 'logs', id, '--after', String(ids[5]), '--json')).toBe(0);
    expect(out.map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(['stop', 'result']);
    out = [];
    expect(await oa('runs', 'show', id)).toBe(0);
    expect(out.find((l) => l.startsWith('transcript'))).toBe(
      `transcript  yes  (oa runs logs ${id})`,
    );
    expect(await oa('runs', 'logs', 'run_nope')).toBe(1);
    expect(await oa('runs', 'logs')).toBe(2);
  });
});

describe('oa cost (#129)', () => {
  const ledgerRow = (runId: string, over: Record<string, unknown>) => ({
    run_id: runId,
    task: 'ok',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    in_tok: 100,
    out_tok: 20,
    cache_read: 10,
    cache_write: 0,
    usd: 0.01,
    priced_by: 'table' as const,
    ts: new Date().toISOString(),
    ...over,
  });

  it('shows cache writes and the pricing source of each group, and flags unpriced calls', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    expect(await oa('run', 'bad', '--wait')).toBe(1);
    const okId = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    const badId = /^failed (run_\w+)/.exec(out[2] ?? '')?.[1] ?? '';
    const ledger = daemon.core.store.ledger;
    ledger.insert(ledgerRow(okId, { cache_write: 400 }));
    ledger.insert(ledgerRow(okId, { cache_write: 30, usd: 0, priced_by: 'unpriced' }));
    ledger.insert(ledgerRow(badId, { task: 'bad', usd: 0.5, priced_by: 'provider' }));
    out = [];

    expect(await oa('cost')).toBe(0);
    expect(out[0]).toBe(
      'task   calls     in_tok    out_tok   cache_rd   cache_wr        usd  priced_by',
    );
    expect(out[1]).toBe(
      'bad        1        100         20         10          0     0.5000  provider',
    );
    expect(out[2]).toBe(
      'ok         2        200         40         20        430     0.0100  table:1,unpriced:1',
    );
    expect(out[3]).toMatch(/^total since \S+: \$0\.5100$/);
    expect(out[4]).toBe('1 unpriced call counts as $0: the daemon could not price it');
    expect(out).toHaveLength(5);

    out = [];
    expect(await oa('cost', '--json')).toBe(0);
    const body = JSON.parse(out[0] ?? '') as { rows: unknown[] };
    expect(body.rows).toEqual([
      expect.objectContaining({
        key: 'bad',
        cache_write: 0,
        priced_by: { table: 0, provider: 1, estimate: 0, unpriced: 0 },
      }),
      expect.objectContaining({
        key: 'ok',
        cache_write: 430,
        priced_by: { table: 1, provider: 0, estimate: 0, unpriced: 1 },
      }),
    ]);
  });

  it('counts several unpriced calls in the note, across groups', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    const okId = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    const ledger = daemon.core.store.ledger;
    ledger.insert(ledgerRow(okId, { usd: 0, priced_by: 'unpriced' }));
    ledger.insert(ledgerRow(okId, { model: 'gpt-x', usd: 0, priced_by: 'unpriced' }));
    out = [];
    expect(await oa('cost', '--by', 'model')).toBe(0);
    expect(out.slice(1, 3).map((l) => l.split(/ +/).at(-1))).toEqual(['unpriced', 'unpriced']);
    expect(out.at(-1)).toBe('2 unpriced calls count as $0: the daemon could not price them');
  });

  it('prints no unpriced note when every call was priced', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    const okId = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    daemon.core.store.ledger.insert(ledgerRow(okId, {}));
    daemon.core.store.ledger.insert(ledgerRow(okId, {}));
    out = [];
    expect(await oa('cost')).toBe(0);
    expect(out[1]).toMatch(/ {2}table$/);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatch(/^total since /);
  });
});

describe('the attempts and output of a run (#89)', () => {
  /** Runs `ok`, then gives it two attempts as a retried shell run would leave them. */
  async function retried(): Promise<string> {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    const id = /^succeeded (run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    out = [];
    const attempts = daemon.core.store.attempts;
    attempts.deleteForRuns([id]);
    attempts.start(id, 1, '2026-09-29T10:00:00.000Z');
    attempts.setOutput(id, 1, { stdout: 'fetching\n', stderr: 'disk full\nretry later\n' });
    attempts.end(id, 1, {
      status: 'failed',
      finished_at: '2026-09-29T10:00:01.500Z',
      error: 'exit code 1: disk full',
    });
    attempts.start(id, 2, '2026-09-29T10:00:05.000Z');
    attempts.setOutput(id, 2, { stdout: 'done', stderr: null });
    attempts.end(id, 2, {
      status: 'succeeded',
      finished_at: '2026-09-29T10:00:06.000Z',
      error: null,
    });
    return id;
  }

  it('lists each attempt in oa runs show, and in its JSON', async () => {
    const id = await retried();
    expect(await oa('runs', 'show', id)).toBe(0);
    const at = out.findIndex((l) => l.startsWith('attempts'));
    expect(out.slice(at, at + 3)).toEqual([
      'attempts    1  failed     2026-09-29T10:00:00.000Z  took 1.5s  exit code 1: disk full',
      '            2  succeeded  2026-09-29T10:00:05.000Z  took 1.0s',
      `output      yes  (oa runs logs ${id})`,
    ]);
    out = [];
    expect(await oa('runs', 'show', id, '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      attempts: [
        { attempt: 1, status: 'failed', stderr: 'disk full\nretry later\n' },
        { attempt: 2, status: 'succeeded', stdout: 'done' },
      ],
    });
  });

  it('prints the output of a non-agent run by attempt in oa runs logs, or as JSON lines', async () => {
    const id = await retried();
    expect(await oa('runs', 'logs', id)).toBe(0);
    expect(out).toEqual([
      'attempt 1  failed  2026-09-29T10:00:00.000Z  took 1.5s  exit code 1: disk full',
      '  stdout',
      '    fetching',
      '  stderr',
      '    disk full',
      '    retry later',
      'attempt 2  succeeded  2026-09-29T10:00:05.000Z  took 1.0s',
      '  stdout',
      '    done',
    ]);
    out = [];
    expect(await oa('runs', 'logs', id, '--json')).toBe(0);
    expect(out.map((l) => (JSON.parse(l) as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it('records a real failed shell run as one attempt', async () => {
    expect(await oa('run', 'bad', '--wait')).toBe(1);
    const id = /(run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    out = [];
    expect(await oa('runs', 'show', id, '--json')).toBe(1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      attempts: [{ attempt: 1, status: 'failed', error: 'exit code 1' }],
    });
  });
});

describe('oa runs cancel', () => {
  it('cancels a waiting run, refuses a finished one and rejects bad input', async () => {
    expect(await oa('run', 'hold')).toBe(0);
    const id = /(run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    out = [];
    expect(await oa('runs', 'cancel', id)).toBe(0);
    expect(out).toEqual([`${id}  hold  cancelled`]);
    out = [];
    expect(await oa('runs', 'ls', '--status', 'cancelled', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      runs: [{ id, status: 'cancelled', error: 'cancelled on request' }],
    });
    const events = daemon.core.store.events.list({ type: 'task.hold.cancelled' });
    expect(events).toMatchObject([{ payload: { run_id: id, previous_status: 'waiting' } }]);

    expect(await oa('runs', 'cancel', id)).toBe(1);
    expect(err[0]).toBe(`daemon: run "${id}" is already cancelled`);
    expect(await oa('runs', 'cancel', 'run_nope')).toBe(1);
    expect(err[1]).toMatch(/unknown run "run_nope"/);
    expect(await oa('runs', 'cancel')).toBe(2);
  });

  it('prints the cancelled run as JSON', async () => {
    expect(await oa('run', 'hold')).toBe(0);
    const id = /(run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    out = [];
    expect(await oa('runs', 'cancel', id, '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ id, task: 'hold', status: 'cancelled' });
  });
});

describe('oa tasks', () => {
  it('lists tasks, pauses one so oa run refuses it, and resumes it', async () => {
    expect(await oa('tasks', 'ls')).toBe(0);
    expect(out).toEqual([
      'ok    manual  active  last=-  runs=0',
      'bad   manual  active  last=-  runs=0',
      'hold  manual  active  last=-  runs=0',
    ]);
    out = [];
    expect(await oa('tasks', 'pause', 'ok')).toBe(0);
    expect(out[0]).toMatch(
      /^ok {2}manual {2}paused since \d{4}-\d\d-\d\dT\S+ {2}last=- {2}runs=0$/,
    );
    out = [];
    expect(await oa('run', 'ok')).toBe(1);
    expect(err[0]).toBe('daemon: task "ok" is paused: resume it with oa tasks resume ok');
    expect(await oa('tasks', 'ls', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      tasks: [
        { name: 'ok', trigger: 'manual', paused_at: expect.any(String) as string },
        { name: 'bad', paused_at: null },
        { name: 'hold', paused_at: null },
      ],
    });
    out = [];
    expect(daemon.core.metrics.render()).toMatch(/^oa_tasks_paused 1$/m);

    expect(await oa('tasks', 'resume', 'ok', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      name: 'ok',
      trigger: 'manual',
      paused_at: null,
    });
    expect(await oa('run', 'ok', '--wait')).toBe(0);

    expect(await oa('tasks', 'pause', 'nope')).toBe(1);
    expect(err.at(-1)).toBe('daemon: unknown task "nope"');
    expect(await oa('tasks', 'pause')).toBe(2);
    expect(await oa('tasks', 'frob')).toBe(2);
  });
});

describe('oa events', () => {
  it('tails the newest events in order with a type filter, shows one, and validates input', async () => {
    expect(await oa('events', 'tail')).toBe(0);
    expect(out).toEqual(['no events']);
    out = [];
    expect(await oa('emit', 'mail.in', '--json')).toBe(0);
    expect(await oa('emit', 'mail.out', '--json')).toBe(0);
    expect(await oa('emit', 'chat.in', '--json')).toBe(0);
    const ids = out.map((l) => (JSON.parse(l) as { event: { id: string } }).event.id);
    out = [];
    expect(await oa('events', 'tail')).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(
      new RegExp(`^\\S+  ${ids[0] ?? ''}  mail\\.in  source=manual  correlation=cor_\\w+$`),
    );
    out = [];
    expect(await oa('events', 'tail', '-n', '1')).toBe(0);
    expect(out[0]).toContain(ids[2]);
    out = [];
    expect(await oa('events', 'tail', '--type', 'mail.*', '--json')).toBe(0);
    expect(out.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual([ids[0], ids[1]]);
    out = [];
    expect(await oa('events', 'show', ids[2] ?? '')).toBe(0);
    expect(out[0]).toContain('chat.in');
    expect(out[1]).toBe('payload: null');
    out = [];
    expect(await oa('events', 'show', ids[2] ?? '', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ event: { id: ids[2], type: 'chat.in' } });
    err = [];

    expect(await oa('events', 'tail', '--type', 'Bad Type')).toBe(2);
    expect(err[0]).toMatch(/invalid query/);
    expect(await oa('events', 'show', 'evt_nope')).toBe(1);
    expect(await oa('events', 'tail', '-n', 'x')).toBe(2);
    expect(await oa('events', 'show')).toBe(2);
    expect(await oa('events')).toBe(2);
  });
});

describe('oa run with declared params (#93)', () => {
  const GREET = `${TASKS}  - name: greet
    trigger:
      kind: manual
      params:
        name: { type: string }
        age: { type: integer, required: false }
    action: { kind: shell, cmd: ["echo", "\${event.payload.name}"] }
`;
  const payloadOf = (eventId: string) => daemon.core.store.events.getById(eventId)?.payload;

  beforeEach(async () => {
    writeFileSync(join(dir, 'tasks.yaml'), GREET);
    expect(await oa('reload')).toBe(0);
    out = [];
  });

  it('passes -p params, converted by the daemon to the declared type', async () => {
    expect(await oa('run', 'greet', '-p', 'name=Ada', '--param', 'age=36', '--json')).toBe(0);
    const { event_id } = JSON.parse(out[0] ?? '') as { event_id: string };
    expect(payloadOf(event_id)).toEqual({
      task: 'greet',
      event: { type: 'manual.input', payload: { name: 'Ada', age: 36 } },
    });
  });

  it('reads a bare payload from a file or stdin, with -p merged over it', async () => {
    writeFileSync(join(dir, 'p.json'), '{"name": "Bob", "age": 1}');
    expect(
      await oa('run', 'greet', '--payload', join(dir, 'p.json'), '-p', 'age=2', '--json'),
    ).toBe(0);
    const { event_id } = JSON.parse(out[0] ?? '') as { event_id: string };
    expect(payloadOf(event_id)).toMatchObject({ event: { payload: { name: 'Bob', age: 2 } } });

    stdin = '{"name": "Cy"}';
    expect(await oa('run', 'greet', '--payload', '-', '--wait')).toBe(0);
    expect(out.at(-1)).toBe('"Cy"');
  });

  it('refuses missing, misspelled and invalid params, naming each, and queues nothing', async () => {
    expect(await oa('run', 'greet', '--wait')).toBe(2);
    expect(err).toEqual([
      'daemon: invalid params for task "greet"',
      '  name: required parameter is missing',
    ]);
    err = [];
    expect(await oa('run', 'greet', '-p', 'nmae=Ada', '-p', 'age=old')).toBe(2);
    expect(err).toEqual([
      'daemon: invalid params for task "greet"',
      '  name: required parameter is missing',
      '  age: expected integer, got string "old"',
      '  nmae: unknown parameter; declared: name, age',
    ]);
    expect(daemon.core.store.runs.list({ task: 'greet' })).toEqual([]);
  });

  it('merges -p over the payload of an --event file, which must be an object', async () => {
    writeFileSync(join(dir, 'ev.json'), '{"type": "x.y", "payload": {"name": "Bob"}}');
    expect(await oa('run', 'greet', '--event', join(dir, 'ev.json'), '-p', 'age=3', '--json')).toBe(
      0,
    );
    const { event_id } = JSON.parse(out[0] ?? '') as { event_id: string };
    expect(payloadOf(event_id)).toMatchObject({
      event: { type: 'x.y', payload: { name: 'Bob', age: 3 } },
    });
    writeFileSync(join(dir, 'ev.json'), '{"payload": "text"}');
    expect(await oa('run', 'greet', '--event', join(dir, 'ev.json'), '-p', 'a=b')).toBe(2);
    expect(err.at(-2)).toBe(`${join(dir, 'ev.json')}: -p needs the payload to be an object`);
  });

  it('rejects malformed -p and --payload input before calling the daemon', async () => {
    expect(await oa('run', 'greet', '-p', 'noequals')).toBe(2);
    expect(err.at(-2)).toMatch(/-p noequals: expected key=value/);
    expect(await oa('run', 'greet', '--payload', '-', '--event', '-')).toBe(2);
    expect(err.at(-2)).toMatch(/--payload and --event cannot be combined/);
    stdin = '[1]';
    expect(await oa('run', 'greet', '--payload', '-', '-p', 'a=b')).toBe(2);
    expect(err.at(-2)).toMatch(/stdin: -p needs the payload to be an object/);
  });
});

describe('why a task did or did not run (#92)', () => {
  const WATCH = `${TASKS}  - name: watch
    trigger: { kind: event, type: order.received, filter: "payload.total > \`10\`" }
    action: { kind: shell, cmd: ["true"] }
  - name: hourly
    trigger: { kind: cron, schedule: "0 * * * *" }
    action: { kind: shell, cmd: ["true"] }
`;

  beforeEach(async () => {
    writeFileSync(join(dir, 'tasks.yaml'), WATCH);
    expect(await oa('reload')).toBe(0);
    out = [];
  });

  it('oa emit warns when no task and no waiting run matches the event', async () => {
    expect(await oa('emit', 'order.recieved')).toBe(0);
    expect(out[0]).toMatch(/^inserted (evt_\w+) type=order\.recieved/);
    const id = /(evt_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    expect(err).toEqual([
      `warning: no task would start a run for order.recieved and no waiting run matches it; oa events show ${id} says why`,
    ]);
    err = [];
    stdin = '{"total": 20}';
    expect(await oa('emit', 'order.received', '-')).toBe(0);
    expect(err).toEqual([]);
    expect(await oa('tasks', 'pause', 'watch')).toBe(0);
    expect(await oa('emit', 'order.received', '-')).toBe(0);
    expect(err).toEqual([
      expect.stringMatching(/^warning: no task would start a run for order\.received/) as string,
    ]);
    expect(await oa('tasks', 'resume', 'watch')).toBe(0);
    err = [];
    expect(await oa('run', 'hold')).toBe(0);
    expect(await oa('emit', 'chat.reply', '--json')).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.at(-1) ?? '')).toMatchObject({
      status: 'inserted',
      waiting_runs: [expect.stringMatching(/^run_/) as string],
      tasks: expect.arrayContaining([
        {
          task: 'watch',
          outcome: 'no_match',
          reason: 'type',
          detail: 'wants order.received',
          run_id: null,
        },
      ]) as unknown,
    });
  });

  it('oa events show lists the runs the event started and why each other task did not run', async () => {
    stdin = '{"total": 20}';
    expect(await oa('emit', 'order.received', '-', '--json')).toBe(0);
    const big = (JSON.parse(out[0] ?? '') as { event: { id: string } }).event.id;
    stdin = '{"total": 5}';
    expect(await oa('emit', 'order.received', '-', '--json')).toBe(0);
    const small = (JSON.parse(out[1] ?? '') as { event: { id: string } }).event.id;
    await vi.waitFor(() => {
      expect(daemon.core.store.runs.list({ task: 'watch' })).toHaveLength(1);
    });
    const [run] = daemon.core.store.runs.list({ task: 'watch' });
    out = [];
    expect(await oa('events', 'show', big)).toBe(0);
    expect(out[1]).toBe('payload: {"total":20}');
    expect(out.slice(2)).toEqual([
      'tasks:',
      '  ok      no match  type: wants manual.run for ok',
      '  bad     no match  type: wants manual.run for bad',
      '  hold    no match  type: wants manual.run for hold',
      `  watch   started   ${run?.id ?? ''}`,
      '  hourly  no match  type: wants its own cron.tick',
    ]);
    out = [];
    expect(await oa('events', 'show', small)).toBe(0);
    expect(out).toContain('  watch   no match  filter is false: payload.total > `10`');
    out = [];
    expect(await oa('events', 'show', big, '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      event: { id: big, type: 'order.received' },
      dispatched: true,
      runs: [{ id: run?.id, task: 'watch' }],
      tasks: expect.arrayContaining([
        { task: 'watch', outcome: 'started', reason: null, detail: null, run_id: run?.id },
      ]) as unknown,
    });
  });

  it('oa tasks ls shows each trigger, the next cron fire, the last run and run counts', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    expect(await oa('run', 'bad', '--wait')).toBe(1);
    out = [];
    expect(await oa('tasks', 'ls')).toBe(0);
    expect(out[0]).toMatch(/^ok {6}manual {2}active {2}last=succeeded \S+ {2}runs=1$/);
    expect(out[1]).toMatch(/^bad {5}manual {2}active {2}last=failed \S+ {2}runs=1 failed=1$/);
    expect(out[2]).toBe('hold    manual  active  last=-  runs=0');
    expect(out[3]).toBe(
      'watch   event   active  on=order.received filter="payload.total > `10`"  last=-  runs=0',
    );
    expect(out[4]).toMatch(
      /^hourly {2}cron {4}active {2}schedule="0 \* \* \* \*" next=\d{4}-\d\d-\d\dT\d\d:00:00\.000Z {2}last=- {2}runs=0$/,
    );
    out = [];
    expect(await oa('tasks', 'ls', '--json')).toBe(0);
    const { tasks } = JSON.parse(out[0] ?? '') as { tasks: Record<string, unknown>[] };
    expect(tasks[1]).toMatchObject({
      name: 'bad',
      trigger: 'manual',
      last_run: { status: 'failed', id: expect.stringMatching(/^run_/) as string },
      runs: { total: 1, failed: 1, succeeded: 0 },
    });
    expect(tasks[3]).toMatchObject({
      types: ['order.received'],
      filter: 'payload.total > `10`',
      schedule: null,
      next_fire: null,
      last_run: null,
    });
    expect(tasks[4]).toMatchObject({
      schedule: '0 * * * *',
      next_fire: expect.stringMatching(/:00:00\.000Z$/) as string,
    });
  });

  it('oa runs show prints what a waiting run waits for', async () => {
    expect(await oa('run', 'hold')).toBe(0);
    const id = /(run_\w+)/.exec(out[0] ?? '')?.[1] ?? '';
    await vi.waitFor(() => {
      expect(daemon.core.store.runs.getById(id)?.status).toBe('waiting');
    });
    out = [];
    expect(await oa('runs', 'show', id)).toBe(0);
    expect(out).toContain('waits for   chat.reply');
    expect(out).toContain('deadline    none');
    out = [];
    expect(await oa('runs', 'show', id, '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      run: { id, status: 'waiting' },
      wait: { type: 'chat.reply', filter: null, expires_at: null, on_timeout: 'fail' },
    });
  });
});

describe('oa connector', () => {
  it('lists connectors and reports an unknown one on restart', async () => {
    expect(await oa('connector', 'list')).toBe(0);
    expect(out[0]).toBe('no connectors');
    expect(await oa('connector', 'list', '--json')).toBe(0);
    expect(JSON.parse(out[1] ?? '')).toEqual({ connectors: [] });
    expect(await oa('connector', 'restart', 'nope')).toBe(1);
    expect(err[0]).toMatch(/unknown connector "nope"/);
    expect(await oa('connector', 'restart')).toBe(2);
    expect(await oa('connector', 'frob')).toBe(2);
  });
});

describe('oa help', () => {
  it('prints usage', async () => {
    expect(await main([], io)).toBe(2);
    expect(await main(['help', 'emit'], io)).toBe(0);
    expect(out[1]).toMatch(/^usage: oa emit/);
    expect(await main(['frobnicate'], io)).toBe(2);
  });

  it('prints the usage of a command for <command> --help and -h, exiting 0 without an error (#110)', async () => {
    const commands = [
      'validate',
      'run',
      'emit',
      'runs',
      'tasks',
      'events',
      'connector',
      'cost',
      'reload',
      'health',
      'metrics',
      'backup',
    ];
    for (const command of commands) {
      for (const flag of ['--help', '-h']) {
        out = [];
        err = [];
        expect(await main([command, flag], io), `${command} ${flag}`).toBe(0);
        expect(err, `${command} ${flag}`).toEqual([]);
        expect(out.join('\n'), `${command} ${flag}`).toMatch(new RegExp(`^usage: oa ${command}`));
      }
    }
    out = [];
    err = [];
    expect(await main(['run', 'ok', '--wait', '--help'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toMatch(/^usage: oa run/);
  });

  it('treats --help after -- as an argument, not a request for usage', async () => {
    expect(await main(['validate', '--', '--help'], io)).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^--help: cannot read file/);
    out = [];
    err = [];
    const tasks = join(EXAMPLES, 'website-updates.yaml');
    expect(await main(['validate', tasks, '--', '-h'], io)).toBe(1);
    expect(out).toEqual([`ok ${tasks} (9 tasks)`]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^-h: cannot read file/);
  });

  it('prints the usage for a help flag after a positional argument', async () => {
    expect(await main(['backup', 'out.db', '--help'], io)).toBe(0);
    expect(await main(['validate', 'a.yaml', '-h'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toMatch(/^usage: oa backup/);
    expect(out[1]).toMatch(/^usage: oa validate/);
  });

  it('says which secrets backends a connector restart picks up a rotation from', async () => {
    expect(await main(['help', 'connector'], io)).toBe(0);
    const help = out.join('\n').replace(/\s+/g, ' ');
    expect(help).toMatch(/file backend this is how a rotated secret reaches/);
    expect(help).toMatch(/env backend, or systemd-credentials.*systemctl restart 247-agent/);
  });
});

describe('oa reload', () => {
  it('reloads the config, reports refused reloads and prints JSON on request', async () => {
    expect(await oa('reload')).toBe(0);
    expect(out).toEqual([
      `ok ${join(dir, 'agent.yaml')}`,
      `ok ${join(dir, 'tasks.yaml')}`,
      'reloaded: 3 tasks',
    ]);
    out = [];
    writeFileSync(join(dir, 'tasks.yaml'), 'tasks: [');
    expect(await oa('reload')).toBe(1);
    expect(err[0]).toMatch(/tasks\.yaml: .*YAML/);
    expect(err.at(-1)).toMatch(/previous config stays active/);
    err = [];
    writeFileSync(join(dir, 'tasks.yaml'), TASKS.replace('cmd: ["false"]', 'cmd: []'));
    expect(await oa('reload')).toBe(1);
    expect(err[0]).toMatch(/tasks\.yaml:7: tasks\[1\]\.action\.cmd: task "bad": /);
    err = [];
    out = [];
    writeFileSync(join(dir, 'tasks.yaml'), TASKS);
    writeFileSync(join(dir, 'agent.yaml'), 'db: other.db\nsocket: core.sock\n');
    expect(await oa('reload', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      ok: true,
      restart_required: ['db'],
      tasks: 3,
    });
    expect(await oa('reload', 'extra')).toBe(2);
  });
});

describe('oa health', () => {
  it('prints each check and exits 0 when ok, 1 when failing', async () => {
    expect(await oa('health')).toBe(0);
    expect(out[0]).toMatch(/^ok\tpid=\d+\tuptime=\d+s\ttasks=3\truns=0 pending, 0 in flight$/);
    expect(out.slice(1)).toEqual(['dispatcher\tok', 'database\tok', 'connectors\tok\tup=0/0']);
    out = [];
    vi.spyOn(daemon.core.store, 'probeWrite').mockImplementation(() => {
      throw new Error('database or disk is full');
    });
    expect(await oa('health')).toBe(1);
    expect(out[0]).toMatch(/^failing\t/);
    expect(out[2]).toBe('database\tfailing error="database or disk is full"');
    out = [];
    expect(await oa('health', '--json')).toBe(1);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ ok: false, status: 'failing' });
    vi.restoreAllMocks();
    expect(await oa('health', 'extra')).toBe(2);
  });

  it('exits 1 when the daemon cannot be reached', async () => {
    expect(await main(['health', '--socket', join(dir, 'nope.sock')], io)).toBe(1);
    expect(err[0]).toMatch(/cannot connect to the daemon/);
  });
});

describe('oa metrics', () => {
  it('prints the Prometheus exposition', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    out = [];
    expect(await oa('metrics')).toBe(0);
    expect(out).toContain('# TYPE oa_runs_finished_total counter');
    expect(out).toContain('oa_runs_finished_total{task="ok",status="succeeded"} 1');
    expect(out.at(-1)).not.toBe('');
    expect(await oa('metrics', 'x')).toBe(2);
  });
});

describe('oa backup', () => {
  it('writes a copy of the running database that a daemon can start on', async () => {
    expect(await oa('run', 'ok', '--wait')).toBe(0);
    await new ApiClient({ socketPath: daemon.config.socket }).putState('ns', 'cursor', 42);
    out = [];
    const file = join(dir, 'backup.db');
    expect(await oa('backup', file)).toBe(0);
    expect(out).toEqual([`wrote ${file}`]);
    expect(err).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}-wal`)).toBe(false);
    // The daemon's own copy next to state.db goes once it is sent.
    await vi.waitFor(() => {
      expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
    });

    const restoredDir = mkdtempSync(join(tmpdir(), 'oa-rs-'));
    try {
      copyFileSync(file, join(restoredDir, 'state.db'));
      writeFileSync(join(restoredDir, 'tasks.yaml'), TASKS);
      writeFileSync(join(restoredDir, 'agent.yaml'), 'db: state.db\nsocket: core.sock\n');
      const restored = await startDaemon({
        configFile: join(restoredDir, 'agent.yaml'),
        log: createLogger({ sink: () => undefined }),
      });
      try {
        const api = new ApiClient({ socketPath: restored.config.socket });
        expect(await api.listRuns({ task: 'ok' })).toMatchObject([{ status: 'succeeded' }]);
        expect(await api.getState('ns', 'cursor')).toMatchObject({ value: 42 });
      } finally {
        await restored.stop();
      }
    } finally {
      rmSync(restoredDir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a file unless --force', async () => {
    const file = join(dir, 'backup.db');
    writeFileSync(file, 'old');
    expect(await oa('backup', file)).toBe(1);
    expect(err[0]).toMatch(/already exists; use --force/);
    expect(readFileSync(file, 'utf8')).toBe('old');
    err = [];
    expect(await oa('backup', file, '--force')).toBe(0);
    expect(readFileSync(file).subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('leaves no file behind when the daemon cannot be reached', async () => {
    const file = join(dir, 'backup.db');
    expect(await main(['backup', file, '--socket', join(dir, 'nope.sock')], io)).toBe(1);
    expect(err[0]).toMatch(/cannot connect to the daemon/);
    expect(readdirSync(dir).filter((f) => f.startsWith('backup'))).toEqual([]);
  });

  it('survives a client that hangs up during the copy and removes its own copy', async () => {
    const store = daemon.core.store;
    const real = store.backup.bind(store);
    let copied!: () => void;
    const done = new Promise<void>((r) => (copied = r));
    vi.spyOn(store, 'backup').mockImplementation(async (dest) => {
      await new Promise((r) => setTimeout(r, 200));
      await real(dest);
      copied();
    });
    const req = request({ socketPath: daemon.config.socket, method: 'POST', path: '/v1/backup' });
    req.on('error', () => undefined);
    req.end();
    setTimeout(() => req.destroy(), 50);
    await done;
    await vi.waitFor(() => {
      expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
    });
    vi.restoreAllMocks();
    expect(await oa('health')).toBe(0);
  });

  it('needs exactly one file', async () => {
    expect(await oa('backup')).toBe(2);
    expect(await oa('backup', 'a.db', 'b.db')).toBe(2);
  });
});
