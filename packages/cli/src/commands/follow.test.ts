import {
  ApiConnectionError,
  ApiError,
  type EventRecord,
  type TranscriptEntry,
} from '@247-agent/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as IoModule from '../io.js';
import type { Io } from '../io.js';

// The follow loops poll every second; the fake daemon below answers at once.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

/** One scripted answer per call: a value, or an error to throw. */
type Step = { ok: unknown } | { fail: Error };
const script = new Map<string, Step[]>();
const calls = new Map<string, unknown[]>();

function answer(method: string, arg: unknown): Promise<unknown> {
  calls.set(method, [...(calls.get(method) ?? []), arg]);
  const step = script.get(method)?.shift();
  if (step === undefined) {
    return Promise.reject(new Error(`stop: no more answers for ${method}`));
  }
  return 'ok' in step ? Promise.resolve(step.ok) : Promise.reject(step.fail);
}

vi.mock('../io.js', async (importOriginal) => {
  const real = await importOriginal<typeof IoModule>();
  return {
    ...real,
    client: () => ({
      listEvents: (q: unknown) => answer('listEvents', q),
      getRun: (id: unknown) => answer('getRun', id),
      getTranscript: (_id: unknown, q: unknown) => answer('getTranscript', q),
      getRunAttempts: (id: unknown) => answer('getRunAttempts', id),
    }),
  };
});

const { events } = await import('./events.js');
const { runs } = await import('./runs.js');
const { eventLine } = await import('./format.js');

const SOCK = '/run/247-agent/core.sock';
const refused = (code = 'ECONNREFUSED') => new ApiConnectionError(SOCK, code);
const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

function event(seq: number): EventRecord {
  return {
    id: `evt_${String(seq)}`,
    seq,
    type: 'x.y',
    source: 'manual',
    payload: {},
    correlation_id: `cor_${String(seq)}`,
    causation_id: null,
    depth: 0,
    dedup_key: null,
    created_at: '2026-11-05T10:00:00.000Z',
  } as unknown as EventRecord;
}

function entry(id: number): TranscriptEntry {
  return {
    id,
    run_id: 'run_1',
    ts: '2026-11-05T10:00:00.000Z',
    turn: 1,
    kind: 'text',
    text: `line ${String(id)}`,
    data: null,
  } as unknown as TranscriptEntry;
}

const run = (status: string) => ({ id: 'run_1', task: 'fix', status, error: null });

let out: string[];
let err: string[];
const io: Io = {
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  readStdin: () => Promise.resolve(''),
};

beforeEach(() => {
  out = [];
  err = [];
  script.clear();
  calls.clear();
});

describe('oa events tail --follow across a daemon restart (#112)', () => {
  it('waits for the daemon, says so once, and resumes after the last event it printed', async () => {
    script.set('listEvents', [
      { ok: [event(1)] },
      { fail: reset() }, // the daemon stops mid-request
      { fail: refused('ENOENT') }, // the socket is gone
      { fail: refused() }, // the socket is back but nobody listens yet
      { ok: [event(2), event(3)] },
    ]);

    await expect(events(['tail', '--follow'], io)).rejects.toThrow('stop');

    expect(out).toEqual([eventLine(event(1)), eventLine(event(2)), eventLine(event(3))]);
    expect(calls.get('listEvents')?.slice(1)).toEqual([
      { type: undefined, after: 1, limit: 1000 },
      { type: undefined, after: 1, limit: 1000 },
      { type: undefined, after: 1, limit: 1000 },
      { type: undefined, after: 1, limit: 1000 },
      { type: undefined, after: 3, limit: 1000 },
    ]);
    expect(err).toEqual([
      'lost the daemon (ECONNRESET); waiting for it to come back (Ctrl-C to stop)',
      'reconnected to the daemon',
    ]);
  });

  it('still fails at once when the daemon is not there to begin with', async () => {
    script.set('listEvents', [{ fail: refused() }]);

    expect(await events(['tail', '--follow'], io)).toBe(1);
    expect(err).toEqual([
      `cannot connect to the daemon at ${SOCK} (ECONNREFUSED). Is 247-agent-core running? Set --socket or OA_CORE_SOCKET.`,
    ]);
  });

  it('does not retry a permission error or an error the daemon answered', async () => {
    script.set('listEvents', [{ ok: [event(1)] }, { fail: refused('EACCES') }]);
    expect(await events(['tail', '--follow'], io)).toBe(1);
    expect(err[0]).toMatch(/permission denied/);

    err = [];
    script.set('listEvents', [{ ok: [event(1)] }, { fail: new ApiError(500, 'boom', []) }]);
    expect(await events(['tail', '--follow'], io)).toBe(1);
    expect(err).toEqual(['daemon: boom']);
  });
});

describe('oa runs logs --follow across a daemon restart (#112)', () => {
  it('resumes after the last transcript entry it printed and ends with the run', async () => {
    script.set('getRun', [
      { ok: run('running') },
      { fail: refused() },
      { ok: run('running') },
      { ok: run('succeeded') },
    ]);
    script.set('getTranscript', [
      { ok: { entries: [entry(1)] } },
      { fail: reset() },
      { ok: { entries: [entry(2)] } },
      { ok: { entries: [] } },
    ]);

    expect(await runs(['logs', 'run_1', '--follow'], io)).toBe(0);

    expect(out.join('\n')).toMatch(/line 1[\s\S]*line 2/);
    expect(out.join('\n').match(/line 1/g)).toHaveLength(1);
    expect(calls.get('getTranscript')).toEqual([
      { after: 0, limit: 1000 },
      { after: 1, limit: 1000 },
      { after: 1, limit: 1000 },
      { after: 2, limit: 1000 },
    ]);
    expect(err).toEqual([
      'lost the daemon (ECONNREFUSED); waiting for it to come back (Ctrl-C to stop)',
      'reconnected to the daemon',
      'lost the daemon (ECONNRESET); waiting for it to come back (Ctrl-C to stop)',
      'reconnected to the daemon',
    ]);
  });

  it('without --follow, a lost daemon is still an error', async () => {
    script.set('getRun', [{ ok: run('running') }]);
    script.set('getTranscript', [{ fail: refused() }]);

    expect(await runs(['logs', 'run_1'], io)).toBe(1);
    expect(err[0]).toMatch(/cannot connect to the daemon/);
  });
});
