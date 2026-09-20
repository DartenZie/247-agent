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
    expect(out).toEqual([`ok ${join(EXAMPLES, 'website-updates.yaml')} (7 tasks)`]);
    out = [];
    expect(await main(['validate', join(EXAMPLES, 'agent.yaml')], io)).toBe(0);
    expect(out).toHaveLength(4); // agent.yaml, its tasks file, two connector manifests
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

describe('oa help', () => {
  it('prints usage', async () => {
    expect(await main([], io)).toBe(2);
    expect(await main(['help', 'emit'], io)).toBe(0);
    expect(out[1]).toMatch(/^usage: oa emit/);
    expect(await main(['frobnicate'], io)).toBe(2);
  });
});
