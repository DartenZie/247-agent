import { describe, expect, it } from 'vitest';

import { OUTPUT_TAIL_CHARS, OutputTail } from './output-tail.js';

describe('OutputTail', () => {
  it('keeps what each stream printed, in order, and null for a silent stream', () => {
    const t = new OutputTail();
    t.write('stdout', 'one\n');
    t.write('stdout', 'two\n');
    t.write('stderr', 'warn\n');
    expect(t.snapshot()).toEqual({ stdout: 'one\ntwo\n', stderr: 'warn\n' });
    expect(new OutputTail().snapshot()).toEqual({ stdout: null, stderr: null });
  });

  it('keeps only the last OUTPUT_TAIL_CHARS of a stream, marked as cut', () => {
    const t = new OutputTail();
    t.write('stdout', 'a'.repeat(3 * OUTPUT_TAIL_CHARS));
    t.write('stdout', 'END');
    const { stdout } = t.snapshot();
    expect(stdout?.length).toBe(OUTPUT_TAIL_CHARS);
    expect(stdout?.startsWith('…')).toBe(true);
    expect(stdout?.endsWith('aEND')).toBe(true);
  });

  it('never holds much more than the cap however much is written', () => {
    const t = new OutputTail();
    for (let i = 0; i < 1000; i++) {
      t.write('stderr', 'x'.repeat(1000));
    }
    expect(t.bufferedChars()).toBeLessThanOrEqual(4 * OUTPUT_TAIL_CHARS);
  });

  it('replaces secret values, longest first, including one split across writes', () => {
    const t = new OutputTail();
    t.addSecrets(['hunter2', 'hunter2-long', '']);
    t.write('stdout', 'token=hunter2-long and hunt');
    t.write('stdout', 'er2\n');
    expect(t.snapshot().stdout).toBe('token=*** and ***\n');
  });

  it('redacts a secret that straddles the cut', () => {
    const secret = 'S'.repeat(40);
    const t = new OutputTail();
    t.addSecrets([secret]);
    // The secret starts just before the last OUTPUT_TAIL_CHARS characters.
    t.write('stdout', 'x'.repeat(100) + secret + 'y'.repeat(OUTPUT_TAIL_CHARS - 20));
    expect(t.snapshot().stdout).not.toMatch(/S/);
  });

  it('starts from what an earlier pass of the attempt stored', () => {
    const t = new OutputTail({ stdout: 'before\n', stderr: null });
    t.write('stdout', 'after\n');
    expect(t.snapshot()).toEqual({ stdout: 'before\nafter\n', stderr: null });
  });
});
