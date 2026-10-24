import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Metrics } from '../metrics.js';
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

  it('publishes loop.detected once per chain when it drops deep events', () => {
    const shallow = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxDepth: 1,
    });
    shallow.setConfig(tasks);
    const root = publish('x.happened');
    const child = publish('x.happened', null, { parent_id: root.id });
    const deep = publish('x.happened', null, { parent_id: child.id });
    publish('x.happened', null, { parent_id: child.id });
    shallow.drain();
    const loops = env.store.events.list({ type: 'loop.detected' });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      source: 'core',
      parent_id: null,
      depth: 0,
      dedup_key: `loop:${root.id}`,
      payload: {
        reason: 'depth',
        limit: 1,
        root_event_id: root.id,
        correlation_id: root.correlation_id,
        event_id: deep.id,
        event_type: 'x.happened',
        depth: 2,
      },
    });
    expect(loops[0]?.correlation_id).not.toBe(root.correlation_id);
    expect(env.lines.filter((l) => l.msg === 'event.depth_exceeded')).toHaveLength(2);
    expect(env.lines.filter((l) => l.msg === 'loop.detected')).toHaveLength(1);
  });

  it('caps the runs one chain starts, across the new correlations of an each fan-out', () => {
    const capped = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxChainRuns: 3,
    });
    capped.setConfig(tasks);
    const root = publish('x.happened', { ok: true }); // a and b: 2 runs
    const items = ['cor_1', 'cor_2', 'cor_3'].map((c) =>
      publish('x.happened', { ok: true }, { parent_id: root.id, correlation_id: c }),
    );
    const other = publish('x.happened'); // another chain: a only
    const queued = capped.drain();
    expect(queued.map((r) => [r.task, r.event_id])).toEqual([
      ['a', root.id],
      ['b', root.id],
      ['a', items[0]?.id],
      ['a', other.id],
    ]);
    expect(env.lines.filter((l) => l.msg === 'event.chain_runs_exceeded')).toHaveLength(3);
    const loops = env.store.events.list({ type: 'loop.detected' });
    expect(loops).toHaveLength(1);
    expect(loops[0]?.payload).toMatchObject({
      reason: 'chain_runs',
      limit: 3,
      root_event_id: root.id,
      correlation_id: 'cor_1',
      event_id: items[0]?.id,
    });
  });

  it('publishes loop.detected again when the batch that first reported it rolls back', () => {
    const capped = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxChainRuns: 1,
    });
    capped.setConfig(tasks);
    const root = publish('x.happened'); // a only: the cap is reached
    publish('x.happened', null, { parent_id: root.id });
    const spy = vi.spyOn(env.store.cursors, 'set').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => capped.drain()).toThrow('disk full');
    spy.mockRestore();
    expect(env.store.events.list({ type: 'loop.detected' })).toEqual([]);
    capped.drain();
    expect(env.store.events.list({ type: 'loop.detected' })).toHaveLength(1);
  });

  it("counts a root's own runs toward the cap when it predates root_id", () => {
    const capped = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxChainRuns: 2,
    });
    capped.setConfig(tasks);
    const root = publish('x.happened', { ok: true });
    expect(capped.drain()).toHaveLength(2);
    env.store.db.prepare('UPDATE events SET root_id = NULL WHERE id = ?').run(root.id);
    publish('x.happened', { ok: true }, { parent_id: root.id });
    expect(capped.drain()).toEqual([]);
  });

  it('counts the chain runs already in the store and takes a new cap on configure', () => {
    const capped = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxChainRuns: 2,
    });
    capped.setConfig(tasks);
    const root = publish('x.happened', { ok: true });
    expect(capped.drain()).toHaveLength(2);
    const child = publish('x.happened', null, { parent_id: root.id });
    expect(capped.drain()).toEqual([]);
    capped.configure({ maxChainRuns: 3 });
    publish('x.happened', null, { parent_id: child.id });
    expect(capped.drain()).toHaveLength(1);
  });

  it('lets an event beyond the depth limit end a wait but start no run', () => {
    const shallow = new Dispatcher({
      store: env.store,
      clock: env.clock,
      log: env.log,
      maxDepth: 1,
    });
    shallow.setConfig(tasks);
    const root = publish('x.happened');
    const child = publish('y.trigger', null, { parent_id: root.id });
    shallow.drain();
    const now = env.clock.now().toISOString();
    env.store.runs.insertQueued({
      id: 'run_w',
      task: 'm',
      event_id: child.id,
      correlation_id: child.correlation_id,
      created_at: now,
    });
    env.store.runs.setStatus('run_w', 'waiting');
    env.store.waits.insert({
      run_id: 'run_w',
      task: 'm',
      type: 'x.happened',
      filter: null,
      expires_at: null,
      on_timeout: 'fail',
      resume: null,
      created_at: now,
      consumed: [],
    });
    const deep = publish('x.happened', null, { parent_id: child.id });
    expect(deep.depth).toBe(2);
    expect(shallow.drain().map((r) => r.id)).toEqual(['run_w']); // resumed; tasks a, b not started
    expect(env.store.waits.get('run_w')).toMatchObject({ outcome: 'matched', event_id: deep.id });
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

  it('reports a failing drain in health() and the counter until one succeeds', () => {
    vi.useFakeTimers();
    const metrics = new Metrics();
    const d = new Dispatcher({ store: env.store, clock: env.clock, log: env.log, metrics });
    d.setConfig(tasks);
    try {
      expect(d.health()).toEqual({ ok: true, error: null, failing_since: null });
      publish('x.happened');
      const spy = vi.spyOn(env.store.runs, 'insertQueued').mockImplementation(() => {
        throw new Error('disk full');
      });
      d.start(10);
      vi.advanceTimersByTime(25);
      const since = env.clock.now().toISOString();
      expect(d.health()).toEqual({ ok: false, error: 'disk full', failing_since: since });
      expect(metrics.render()).toMatch(/^oa_dispatch_failures_total 2$/m);
      spy.mockRestore();
      vi.advanceTimersByTime(10);
      expect(d.health()).toEqual({ ok: true, error: null, failing_since: null });
      expect(env.lines.map((l) => l.msg)).toContain('dispatch.recovered');
    } finally {
      d.stop();
      vi.useRealTimers();
    }
  });
});
