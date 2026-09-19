import { describe, expect, it } from 'vitest';

import { createLogger } from './log.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    sink: (l) => {
      lines.push(JSON.parse(l) as Record<string, unknown>);
    },
    level: 'debug',
    clock: () => new Date('2026-09-19T10:00:00.000Z'),
  });
  return { lines, log };
}

describe('createLogger', () => {
  it('writes one JSON object per line with ts, level and msg', () => {
    const { lines, log } = capture();
    log.info('run.queued', { run_id: 'run_1', task: 't' });
    expect(lines).toEqual([
      {
        ts: '2026-09-19T10:00:00.000Z',
        level: 'info',
        msg: 'run.queued',
        run_id: 'run_1',
        task: 't',
      },
    ]);
  });

  it('merges child fields and lets call fields override them', () => {
    const { lines, log } = capture();
    const child = log.child({ task: 'a', correlation_id: 'cor_1' });
    child.warn('x', { task: 'b', event_id: 'evt_1', skipped: undefined });
    expect(lines[0]).toMatchObject({ task: 'b', correlation_id: 'cor_1', event_id: 'evt_1' });
    expect(lines[0]).not.toHaveProperty('skipped');
  });

  it('filters below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), level: 'warn' });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines).toHaveLength(2);
  });
});
