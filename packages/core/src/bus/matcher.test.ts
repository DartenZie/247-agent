import { describe, expect, it } from 'vitest';

import { createLogger } from '../log.js';
import type { EventRecord } from '../store/types.js';
import { taskSource } from './matcher.js';
import { config, shell } from './testing.js';

function ev(over: Partial<EventRecord>): EventRecord {
  return {
    seq: 1,
    id: 'evt_1',
    type: 'x.y',
    source: 'test',
    ts: '2026-09-19T10:00:00.000Z',
    correlation_id: 'cor_1',
    parent_id: null,
    dedup_key: null,
    depth: 0,
    payload: null,
    ...over,
  };
}

const cronTask = config([
  { name: 'poll', trigger: { kind: 'cron', schedule: '* * * * *' }, action: shell },
]).tasks[0];
const manualTask = config([{ name: 'm', trigger: { kind: 'manual' }, action: shell }]).tasks[0];
const notify = config([
  {
    name: 'notify',
    trigger: { kind: 'event', type_any: ['task.*.failed', 'budget.exceeded'] },
    action: shell,
  },
]).tasks[0];
const classify = config([
  {
    name: 'classify',
    trigger: {
      kind: 'event',
      type: 'email.received',
      filter: "payload.from == 'editor@example.com'",
    },
    action: shell,
  },
]).tasks[0];

describe('compileTask', () => {
  it('cron tasks match only their own tick', () => {
    expect(cronTask?.overlapSkip).toBe(true);
    expect(cronTask?.matches(ev({ type: 'cron.tick', payload: { task: 'poll' } }))).toBe(true);
    expect(cronTask?.matches(ev({ type: 'cron.tick', payload: { task: 'other' } }))).toBe(false);
    expect(cronTask?.matches(ev({ type: 'email.received' }))).toBe(false);
  });

  it('event tasks match by type pattern and filter', () => {
    expect(notify?.matches(ev({ type: 'task.publish.failed' }))).toBe(true);
    expect(notify?.matches(ev({ type: 'budget.exceeded' }))).toBe(true);
    expect(notify?.matches(ev({ type: 'task.publish.succeeded' }))).toBe(false);
    expect(notify?.matches(ev({ type: 'task.a.b.failed' }))).toBe(false);
    const from = (f: string) => ev({ type: 'email.received', payload: { from: f } });
    expect(classify?.matches(from('editor@example.com'))).toBe(true);
    expect(classify?.matches(from('spam@example.com'))).toBe(false);
    expect(classify?.matches(ev({ type: 'email.received' }))).toBe(false);
  });

  it('treats a filter runtime error as no match and warns', () => {
    const t = config([
      { name: 't', trigger: { kind: 'event', type: 'a.b', filter: 'sum(payload)' }, action: shell },
    ]).tasks[0];
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'debug' });
    expect(t?.matches(ev({ type: 'a.b', payload: 'oops' }), log)).toBe(false);
    expect(lines[0]).toContain('trigger.filter_error');
  });

  it('never matches events produced by the task itself', () => {
    expect(notify?.matches(ev({ type: 'task.notify.failed', source: taskSource('notify') }))).toBe(
      false,
    );
    expect(notify?.matches(ev({ type: 'task.other.failed', source: taskSource('other') }))).toBe(
      true,
    );
    expect(
      notify?.matches(
        ev({ type: 'manual.run', source: taskSource('notify'), payload: { task: 'notify' } }),
      ),
    ).toBe(false);
  });

  it('matches manual.run for its own name whatever the trigger kind', () => {
    for (const t of [cronTask, manualTask, notify, classify]) {
      expect(
        t?.matches(ev({ type: 'manual.run', source: 'manual', payload: { task: t.name } })),
      ).toBe(true);
      expect(
        t?.matches(ev({ type: 'manual.run', source: 'manual', payload: { task: 'someone_else' } })),
      ).toBe(false);
    }
    expect(manualTask?.matches(ev({ type: 'cron.tick', payload: { task: 'm' } }))).toBe(false);
    expect(manualTask?.matches(ev({ type: 'anything.else' }))).toBe(false);
  });
});
