import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InvalidEventError, publishEvent } from './publish.js';
import { testEnv, type TestEnv } from './testing.js';

let env: TestEnv;
beforeEach(() => {
  env = testEnv();
});
afterEach(() => {
  env.close();
});

describe('publishEvent', () => {
  it('assigns id, ts and a fresh correlation id', () => {
    const r = publishEvent(env.store, env.clock, env.log, {
      type: 'a.b',
      source: 'test',
      payload: { x: 1 },
    });
    expect(r.status).toBe('inserted');
    if (r.status === 'inserted') {
      expect(r.event).toMatchObject({
        seq: 1,
        type: 'a.b',
        source: 'test',
        ts: '2026-09-19T10:00:00.000Z',
        parent_id: null,
        dedup_key: null,
        depth: 0,
        payload: { x: 1 },
      });
      expect(r.event.id).toMatch(/^evt_/);
      expect(r.event.correlation_id).toMatch(/^cor_/);
      expect(env.store.events.getById(r.event.id)).toEqual(r.event);
    }
  });

  it('inherits correlation id and depth from the parent; an explicit correlation id wins', () => {
    const parent = publishEvent(env.store, env.clock, env.log, { type: 'a.b', source: 'test' });
    if (parent.status !== 'inserted') {
      throw new Error('unexpected');
    }
    const child = publishEvent(env.store, env.clock, env.log, {
      type: 'a.c',
      source: 'task:x',
      parent_id: parent.event.id,
    });
    expect(child).toMatchObject({
      status: 'inserted',
      event: { correlation_id: parent.event.correlation_id, depth: 1, parent_id: parent.event.id },
    });
    const explicit = publishEvent(env.store, env.clock, env.log, {
      type: 'a.d',
      source: 'test',
      parent_id: parent.event.id,
      correlation_id: 'cor_custom',
    });
    expect(explicit).toMatchObject({
      status: 'inserted',
      event: { correlation_id: 'cor_custom', depth: 1 },
    });
  });

  it('rejects unknown parents and wildcard types', () => {
    expect(() =>
      publishEvent(env.store, env.clock, env.log, {
        type: 'a.b',
        source: 't',
        parent_id: 'evt_nope',
      }),
    ).toThrow(InvalidEventError);
    expect(() => publishEvent(env.store, env.clock, env.log, { type: 'a.*', source: 't' })).toThrow(
      InvalidEventError,
    );
    expect(env.store.events.listAfter(0, 10)).toEqual([]);
  });

  it('drops duplicates by dedup_key and logs without the payload', () => {
    const input = {
      type: 'email.received',
      source: 'email',
      dedup_key: 'email:1',
      payload: { secret: 'x' },
    };
    expect(publishEvent(env.store, env.clock, env.log, input).status).toBe('inserted');
    expect(publishEvent(env.store, env.clock, env.log, input)).toEqual({
      status: 'duplicate',
      dedup_key: 'email:1',
    });
    expect(env.store.events.listAfter(0, 10)).toHaveLength(1);
    const dup = env.lines.find((l) => l.msg === 'event.duplicate');
    expect(dup).toMatchObject({ dedup_key: 'email:1' });
    expect(JSON.stringify(env.lines)).not.toContain('secret');
  });
});
