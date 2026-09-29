import { describe, expect, it } from 'vitest';

import { createLogger } from '../log.js';
import type { NewTranscriptEntry } from '../store/transcripts.js';
import { TRANSCRIPT_TEXT_MAX, TranscriptWriter } from './agent-transcript.js';

function writer(secrets: Record<string, string> = {}) {
  const rows: NewTranscriptEntry[] = [];
  const lines: Record<string, unknown>[] = [];
  let failing = false;
  const w = new TranscriptWriter({
    sink: {
      append: (e) => {
        if (failing) {
          throw new Error('disk full');
        }
        rows.push(e);
        return rows.length;
      },
    },
    runId: 'run_1',
    secrets,
    log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
    clock: () => new Date('2026-09-29T10:00:00.000Z'),
  });
  return {
    w,
    rows,
    lines,
    fail: () => {
      failing = true;
    },
  };
}

describe('TranscriptWriter', () => {
  it('records the prompt, coalesces message chunks per kind, and keeps structured kinds in order', () => {
    const { w, rows } = writer();
    w.begin('do the thing');
    w.update({ kind: 'text', text: 'Work', messageId: 'm1' });
    w.update({ kind: 'text', text: 'ing. ', messageId: 'm1' });
    w.update({ kind: 'thought', text: 'hmm' });
    w.update({ kind: 'thought', text: '…' });
    w.update({
      kind: 'tool_call',
      id: 'c1',
      title: 'Build',
      toolKind: 'execute',
      status: 'pending',
      command: 'npm run build',
      locations: [],
    });
    w.permission(
      {
        toolCall: {
          id: 'c1',
          title: 'Build',
          toolKind: 'execute',
          command: 'npm run build',
          locations: [],
        },
        options: [{ optionId: 'y', kind: 'allow_once' }],
      },
      { allow: true, optionId: 'y' },
    );
    w.update({
      kind: 'tool_call_update',
      id: 'c1',
      status: 'completed',
      toolKind: undefined,
      command: undefined,
      locations: undefined,
    });
    w.update({ kind: 'other', sessionUpdate: 'plan' });
    w.update({ kind: 'usage', used: 10, size: 100, costUsd: 0.5 });
    w.update({ kind: 'text', text: 'Done.', messageId: 'm2' });
    w.stop({ stopReason: 'end_turn', usage: { input: 1, output: 2 } });
    w.result({ status: 'done', summary: 'ok' });
    expect(rows.map((r) => [r.turn, r.kind, r.text])).toEqual([
      [1, 'prompt', 'do the thing'],
      [1, 'text', 'Working. '],
      [1, 'thought', 'hmm…'],
      [1, 'tool_call', null],
      [1, 'permission', null],
      [1, 'tool_call_update', null],
      [1, 'usage', null],
      [1, 'text', 'Done.'],
      [1, 'stop', null],
      [1, 'result', null],
    ]);
    expect(rows[3]?.data).toEqual({
      id: 'c1',
      title: 'Build',
      tool_kind: 'execute',
      status: 'pending',
      command: 'npm run build',
      locations: [],
    });
    expect(rows[4]?.data).toMatchObject({ id: 'c1', allowed: true, option_id: 'y' });
    expect(rows[5]?.data).toEqual({ id: 'c1', status: 'completed' });
    expect(rows[6]?.data).toEqual({ used: 10, size: 100, cost_usd: 0.5 });
    expect(rows[8]?.data).toEqual({ stop_reason: 'end_turn', input_tokens: 1, output_tokens: 2 });
    expect(rows[9]?.data).toEqual({ status: 'done', summary: 'ok' });
    expect(rows.every((r) => r.run_id === 'run_1' && r.ts === '2026-09-29T10:00:00.000Z')).toBe(
      true,
    );
  });

  it('numbers turns, flushes buffered text on begin/flush/cancel, and splits very long text', () => {
    const { w, rows } = writer();
    w.begin('one');
    w.update({ kind: 'text', text: 'a'.repeat(TRANSCRIPT_TEXT_MAX + 5), messageId: null });
    w.cancel('policy', 'curl is not allowed');
    w.begin('two');
    w.update({ kind: 'text', text: 'tail', messageId: null });
    w.flush();
    w.flush();
    expect(rows.map((r) => [r.turn, r.kind, r.text?.length ?? null])).toEqual([
      [1, 'prompt', 3],
      [1, 'text', TRANSCRIPT_TEXT_MAX],
      [1, 'text', 5],
      [1, 'cancel', null],
      [2, 'prompt', 3],
      [2, 'text', 4],
    ]);
    expect(rows[3]?.data).toEqual({ reason: 'policy', detail: 'curl is not allowed' });
  });

  it('replaces secret values everywhere and ignores ones too short to redact', () => {
    const { w, rows } = writer({ token: 'sk-live-abc', pin: '12', key: 'sk-live-abc-longer' });
    w.begin('use sk-live-abc-longer and sk-live-abc, pin 12');
    w.update({ kind: 'text', text: 'the token is sk-live-abc', messageId: null });
    w.update({
      kind: 'tool_call',
      id: 'c1',
      title: 'curl -H sk-live-abc',
      toolKind: 'execute',
      status: 'pending',
      command: 'curl -H "Authorization: sk-live-abc"',
      locations: ['/tmp/sk-live-abc'],
    });
    w.flush();
    expect(rows[0]?.text).toBe('use [secret:key] and [secret:token], pin 12');
    expect(rows[1]?.text).toBe('the token is [secret:token]');
    expect(rows[2]?.data).toMatchObject({
      title: 'curl -H [secret:token]',
      command: 'curl -H "Authorization: [secret:token]"',
      locations: ['/tmp/[secret:token]'],
    });
    expect(JSON.stringify(rows)).not.toContain('sk-live');
  });

  it('is a no-op without a sink and gives up quietly after a failing write', () => {
    const none = new TranscriptWriter({
      sink: undefined,
      runId: 'run_1',
      secrets: {},
      log: createLogger({ sink: () => undefined }),
    });
    none.begin('x');
    none.update({ kind: 'text', text: 'y', messageId: null });
    none.flush();

    const { w, rows, lines, fail } = writer();
    w.begin('one');
    fail();
    w.update({ kind: 'usage', used: 1, size: 2, costUsd: undefined });
    w.update({ kind: 'usage', used: 1, size: 2, costUsd: undefined });
    expect(rows).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'agent.transcript_failed')).toHaveLength(1);
  });
});
