import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, startDaemon, type Daemon } from '@247-agent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(out).toEqual([`ok ${join(EXAMPLES, 'website-updates.yaml')} (8 tasks)`]);
    out = [];
    expect(await main(['validate', join(EXAMPLES, 'decide-triage.yaml')], io)).toBe(0);
    expect(out).toEqual([`ok ${join(EXAMPLES, 'decide-triage.yaml')} (2 tasks)`]);
    out = [];
    expect(await main(['validate', join(EXAMPLES, 'agent.yaml')], io)).toBe(0);
    expect(out).toHaveLength(10); // agent.yaml, its tasks file, eight connector manifests
    expect(err).toEqual([]);
  });

  it('fails on a bad file and on no file', async () => {
    writeFileSync(join(dir, 'bad.yaml'), 'tasks: []\n');
    expect(await main(['validate', join(dir, 'bad.yaml')], io)).toBe(1);
    expect(err[0]).toMatch(/bad\.yaml: tasks:/);
    expect(await main(['validate'], io)).toBe(2);
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
    expect(out).toEqual([`no transcript for ${id} (ok, succeeded): only agent runs record one`]);
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
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ id: ids[2], type: 'chat.in' });

    expect(await oa('events', 'tail', '--type', 'Bad Type')).toBe(2);
    expect(err[0]).toMatch(/invalid query/);
    expect(await oa('events', 'show', 'evt_nope')).toBe(1);
    expect(await oa('events', 'tail', '-n', 'x')).toBe(2);
    expect(await oa('events', 'show')).toBe(2);
    expect(await oa('events')).toBe(2);
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
});

describe('oa reload', () => {
  it('reloads the config, reports refused reloads and prints JSON on request', async () => {
    expect(await oa('reload')).toBe(0);
    expect(out).toEqual([
      `ok ${join(dir, 'agent.yaml')}`,
      `ok ${join(dir, 'tasks.yaml')}`,
      'reloaded: 2 tasks',
    ]);
    out = [];
    writeFileSync(join(dir, 'tasks.yaml'), 'tasks: [');
    expect(await oa('reload')).toBe(1);
    expect(err[0]).toMatch(/tasks\.yaml: .*YAML/);
    expect(err.at(-1)).toMatch(/previous config stays active/);
    err = [];
    out = [];
    writeFileSync(join(dir, 'tasks.yaml'), TASKS);
    writeFileSync(join(dir, 'agent.yaml'), 'db: other.db\nsocket: core.sock\n');
    expect(await oa('reload', '--json')).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      ok: true,
      restart_required: ['db'],
      tasks: 2,
    });
    expect(await oa('reload', 'extra')).toBe(2);
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
