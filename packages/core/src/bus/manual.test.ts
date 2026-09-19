import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBus, type EventBus } from './bus.js';
import { runTaskManually, UnknownTaskError } from './manual.js';
import { config, shell, testEnv, type TestEnv } from './testing.js';

let env: TestEnv;
let bus: EventBus;
const tasks = config([
  { name: 'poll', trigger: { kind: 'cron', schedule: '* * * * *' }, action: shell },
  { name: 'e', trigger: { kind: 'event', type: 'x.y', filter: 'payload.never' }, action: shell },
  { name: 'm', trigger: { kind: 'manual' }, action: shell },
]);

beforeEach(() => {
  env = testEnv();
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  bus.dispatcher.setConfig(tasks);
});
afterEach(() => {
  bus.dispatcher.stop();
  env.close();
});

describe('runTaskManually', () => {
  it('queues a run synchronously with the input preserved in the event', () => {
    const { event_id, run } = runTaskManually(bus, env.store, tasks, 'm', {
      type: 'x.y',
      payload: { hello: 1 },
      correlation_id: 'cor_manual',
    });
    expect(run).toMatchObject({
      task: 'm',
      status: 'queued',
      event_id,
      correlation_id: 'cor_manual',
    });
    expect(env.store.events.getById(event_id)).toMatchObject({
      type: 'manual.run',
      source: 'manual',
      payload: { task: 'm', event: { type: 'x.y', payload: { hello: 1 } } },
    });
    expect(env.store.runs.listByStatus('queued')).toHaveLength(1);
  });

  it('works without input and for any trigger kind, ignoring filters and overlap skip', () => {
    expect(runTaskManually(bus, env.store, tasks, 'e').run.task).toBe('e');
    const first = runTaskManually(bus, env.store, tasks, 'poll');
    const second = runTaskManually(bus, env.store, tasks, 'poll');
    expect(first.run.id).not.toBe(second.run.id);
    expect(
      env.store.runs
        .listByStatus('queued')
        .map((r) => r.task)
        .sort(),
    ).toEqual(['e', 'poll', 'poll']);
  });

  it('rejects unknown tasks without publishing anything', () => {
    expect(() => runTaskManually(bus, env.store, tasks, 'nope')).toThrow(UnknownTaskError);
    expect(env.store.events.listAfter(0, 10)).toEqual([]);
  });
});
