import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '../store/types.js';
import { Dispatcher } from './dispatcher.js';
import { publishEvent } from './publish.js';
import { config, shell, testEnv, type TestEnv } from './testing.js';

let env: TestEnv;
let dispatcher: Dispatcher;

const tasks = config([
  { name: 'poll', trigger: { kind: 'cron', schedule: '* * * * *' }, action: shell },
  {
    name: 'poll_allow',
    trigger: { kind: 'cron', schedule: '* * * * *', overlap: 'allow' },
    action: shell,
  },
  { name: 'a', trigger: { kind: 'event', type: 'x.happened' }, action: shell },
  { name: 'b', trigger: { kind: 'event', type: 'x.*', filter: 'payload.ok' }, action: shell },
  { name: 'm', trigger: { kind: 'manual' }, action: shell },
]);

function publish(type: string, payload: unknown = null, over: Record<string, string> = {}) {
  const r = publishEvent(env.store, env.clock, env.log, {
    type,
    source: 'test',
    payload: payload as never,
    ...over,
  });
  if (r.status !== 'inserted') {
    throw new Error('dup');
  }
  return r.event;
}

beforeEach(() => {
  env = testEnv();
  dispatcher = new Dispatcher({ store: env.store, clock: env.clock, log: env.log, batchSize: 3 });
  dispatcher.setConfig(tasks);
});
afterEach(() => {
  dispatcher.stop();
  env.close();
});

describe('Dispatcher', () => {
  it('fans one event out to every matching task and advances the cursor', () => {
    const e = publish('x.happened', { ok: true });
    const r = dispatcher.dispatchOnce();
    expect(r.scanned).toBe(1);
    expect(r.queued.map((q) => q.task).sort()).toEqual(['a', 'b']);
    expect(r.queued[0]).toMatchObject({
      status: 'queued',
      event_id: e.id,
      correlation_id: e.correlation_id,
    });
    expect(env.store.cursors.get('dispatch')).toBe(e.seq);
    expect(env.store.runs.listByStatus('queued')).toHaveLength(2);
    expect(dispatcher.dispatchOnce()).toEqual({ scanned: 0, queued: [] });
  });

  it('creates no duplicate runs when a batch is replayed', () => {
    publish('x.happened');
    dispatcher.dispatchOnce();
    env.store.cursors.set('dispatch', 0); // simulate a crash before the cursor commit
    expect(dispatcher.dispatchOnce().queued).toEqual([]);
    expect(env.store.runs.listByStatus('queued')).toHaveLength(1);
  });

  it('leaves cursor and runs untouched when the transaction throws', () => {
    publish('x.happened');
    const spy = vi.spyOn(env.store.runs, 'insertQueued').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => dispatcher.dispatchOnce()).toThrow('disk full');
    spy.mockRestore();
    expect(env.store.cursors.get('dispatch')).toBe(0);
    expect(env.store.runs.listByStatus('queued')).toEqual([]);
    expect(dispatcher.dispatchOnce().queued).toHaveLength(1);
  });

  it('skips cron ticks while a run is active unless overlap is allowed', () => {
    publish('cron.tick', { task: 'poll' });
    publish('cron.tick', { task: 'poll_allow' });
    const first = dispatcher.drain();
    expect(first.map((r) => r.task)).toEqual(['poll', 'poll_allow']);

    publish('cron.tick', { task: 'poll' });
    publish('cron.tick', { task: 'poll_allow' });
    expect(dispatcher.drain().map((r) => r.task)).toEqual(['poll_allow']);
    expect(env.lines.filter((l) => l.msg === 'cron.skipped_overlap')).toHaveLength(1);

    for (const status of ['running', 'waiting'] as const) {
      env.store.runs.setStatus(first[0]?.id ?? '', status);
      publish('cron.tick', { task: 'poll' });
      expect(dispatcher.drain()).toEqual([]);
    }
    env.store.runs.setStatus(first[0]?.id ?? '', 'succeeded');
    publish('cron.tick', { task: 'poll' });
    expect(dispatcher.drain().map((r) => r.task)).toEqual(['poll']);
  });

  it('drops events beyond the depth limit with a warning', () => {
    const shallow = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxDepth: 1,
    });
    shallow.setConfig(tasks);
    const root = publish('x.happened');
    const child = publish('x.happened', null, { parent_id: root.id });
    publish('x.happened', null, { parent_id: child.id });
    expect(shallow.drain().map((r) => r.event_id)).toEqual([root.id, child.id]);
    expect(env.lines.filter((l) => l.msg === 'event.depth_exceeded')).toHaveLength(1);
  });

  it('notifies listeners once per batch and drains across batches', () => {
    const batches: RunRecord[][] = [];
    const off = dispatcher.onQueued((runs) => batches.push([...runs]));
    for (let i = 0; i < 7; i++) {
      publish('x.happened');
    }
    expect(dispatcher.drain()).toHaveLength(7);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    off();
    publish('x.happened');
    dispatcher.drain();
    expect(batches).toHaveLength(3);
  });

  it('applies a new config to the next batch', () => {
    publish('y.other');
    expect(dispatcher.drain()).toEqual([]);
    dispatcher.setConfig(
      config([{ name: 'z', trigger: { kind: 'event', type: 'y.other' }, action: shell }]),
    );
    publish('y.other');
    expect(dispatcher.drain().map((r) => r.task)).toEqual(['z']);
  });

  it('coalesces wakes and drains on the next macrotask', async () => {
    publish('x.happened');
    publish('x.happened');
    dispatcher.wake();
    dispatcher.wake();
    expect(env.store.runs.listByStatus('queued')).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(env.store.runs.listByStatus('queued')).toHaveLength(2);
  });

  it('logs instead of throwing when a periodic drain fails', () => {
    vi.useFakeTimers();
    try {
      publish('x.happened');
      vi.spyOn(env.store.runs, 'insertQueued').mockImplementation(() => {
        throw new Error('boom');
      });
      dispatcher.start(10);
      vi.advanceTimersByTime(25);
      expect(env.lines.filter((l) => l.msg === 'dispatch.failed').length).toBeGreaterThan(0);
      dispatcher.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
