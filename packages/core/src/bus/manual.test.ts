import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBus, type EventBus } from './bus.js';
import { InvalidParamsError, runTaskManually, UnknownTaskError } from './manual.js';
import { config, shell, testEnv, type TestEnv } from './testing.js';

let env: TestEnv;
let bus: EventBus;
const tasks = config([
  { name: 'poll', trigger: { kind: 'cron', schedule: '* * * * *' }, action: shell },
  { name: 'e', trigger: { kind: 'event', type: 'x.y', filter: 'payload.never' }, action: shell },
  { name: 'm', trigger: { kind: 'manual' }, action: shell },
  {
    name: 'greet',
    trigger: {
      kind: 'manual',
      params: {
        name: { type: 'string' },
        age: { type: 'integer', required: false },
        loud: { type: 'boolean', default: false },
        env: { enum: ['staging', 'prod'], default: 'staging' },
      },
    },
    action: shell,
  },
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

  it('validates declared params, fills defaults and converts strings to the declared type', () => {
    const { event_id } = runTaskManually(bus, env.store, tasks, 'greet', {
      payload: { name: 'Ada', age: '36', loud: 'true' },
    });
    expect(env.store.events.getById(event_id)?.payload).toEqual({
      task: 'greet',
      event: {
        type: 'manual.input',
        payload: { name: 'Ada', age: 36, loud: true, env: 'staging' },
      },
    });
  });

  it('rejects missing, unknown and invalid params, naming each, without publishing', () => {
    const attempt = (payload?: unknown) => {
      try {
        runTaskManually(
          bus,
          env.store,
          tasks,
          'greet',
          payload === undefined ? undefined : { payload: payload as never },
        );
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidParamsError);
        return (err as InvalidParamsError).issues;
      }
      throw new Error('expected InvalidParamsError');
    };
    expect(attempt()).toEqual([{ path: 'name', message: 'required parameter is missing' }]);
    expect(attempt({ nmae: 'Ada', age: 'old', env: 'dev', loud: 'maybe' })).toEqual([
      { path: 'name', message: 'required parameter is missing' },
      { path: 'age', message: 'expected integer, got string "old"' },
      { path: 'loud', message: 'expected boolean, got string "maybe"' },
      { path: 'env', message: 'expected one of "staging", "prod", got "dev"' },
      { path: 'nmae', message: 'unknown parameter; declared: name, age, loud, env' },
    ]);
    expect(attempt(['Ada'])).toEqual([
      { path: '', message: 'parameters must be an object, got array' },
    ]);
    expect(env.store.events.listAfter(0, 10)).toEqual([]);
  });

  it('reads only own payload keys and converts only plain decimal numbers', () => {
    const odd = config([
      {
        name: 'odd',
        trigger: {
          kind: 'manual',
          params: {
            constructor: { required: false },
            n: { type: 'integer', required: false },
            tags: { type: 'array', required: false },
          },
        },
        action: shell,
      },
    ]);
    bus.dispatcher.setConfig(odd);
    const payload = (p: Record<string, string>) =>
      env.store.events.getById(runTaskManually(bus, env.store, odd, 'odd', { payload: p }).event_id)
        ?.payload;
    expect(payload({})).toMatchObject({ event: { payload: {} } });
    expect(payload({ n: '-12', tags: '["a"]' })).toMatchObject({
      event: { payload: { n: -12, tags: ['a'] } },
    });
    for (const n of ['0x10', ' 3', '9007199254740993']) {
      expect(() => runTaskManually(bus, env.store, odd, 'odd', { payload: { n } })).toThrow(
        InvalidParamsError,
      );
    }
  });

  it('rejects unknown tasks without publishing anything', () => {
    expect(() => runTaskManually(bus, env.store, tasks, 'nope')).toThrow(UnknownTaskError);
    expect(env.store.events.listAfter(0, 10)).toEqual([]);
  });
});
