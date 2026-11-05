import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../log.js';
import { LineReader, MAX_LINE_CHARS, OutputLimiter, pipeLines } from './output.js';

let lines: Record<string, unknown>[];
const log = () =>
  createLogger({
    level: 'debug',
    sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });

beforeEach(() => {
  lines = [];
});

/** Writes `chunks` to a fresh stream piped to the log and resolves once it is drained. */
async function feed(
  chunks: string[],
  limiter?: OutputLimiter,
  name = 'stderr',
): Promise<Record<string, unknown>[]> {
  const stream = new PassThrough();
  const done = pipeLines(stream, name, log(), limiter);
  for (const c of chunks) {
    stream.write(c);
  }
  stream.end();
  await done;
  return lines;
}

const outputs = () => lines.filter((l) => l.msg === 'connector.output');

describe('pipeLines', () => {
  it('logs each line as connector.output with its stream', async () => {
    await feed(['one\ntw', 'o\r\n', 'three']);
    expect(outputs()).toMatchObject([
      { level: 'info', stream: 'stderr', line: 'one' },
      { level: 'info', stream: 'stderr', line: 'two' },
      { level: 'info', stream: 'stderr', line: 'three' },
    ]);
  });

  it(`cuts a long line at ${String(MAX_LINE_CHARS)} characters and marks it truncated`, async () => {
    await feed(['x'.repeat(5000) + '\nshort\n']);
    expect(outputs()).toHaveLength(2);
    expect(outputs()[0]).toMatchObject({ truncated: true, chars: 5000 });
    expect(String(outputs()[0]?.line)).toHaveLength(MAX_LINE_CHARS);
    expect(outputs()[1]).toMatchObject({ line: 'short' });
    expect(outputs()[1]?.truncated).toBeUndefined();
  });

  it('does not mark a line of exactly the cut, ended by CRLF, as truncated', async () => {
    await feed(['a'.repeat(MAX_LINE_CHARS) + '\r', '\n']);
    expect(outputs()).toHaveLength(1);
    expect(String(outputs()[0]?.line)).toHaveLength(MAX_LINE_CHARS);
    expect(outputs()[0]?.truncated).toBeUndefined();
  });

  it('keeps no more than the cut of an unterminated line, however much arrives', () => {
    const got: { line: string; chars: number }[] = [];
    const reader = new LineReader(MAX_LINE_CHARS, (line, chars) => got.push({ line, chars }));
    const chunk = 'y'.repeat(64 * 1024);
    for (let i = 0; i < 160; i++) {
      reader.push(chunk); // 10 MB, no newline
      expect(reader.pending).toBeLessThanOrEqual(MAX_LINE_CHARS);
    }
    reader.end();
    expect(got).toHaveLength(1);
    expect(got[0]?.chars).toBe(160 * 64 * 1024);
    expect(got[0]?.line).toHaveLength(MAX_LINE_CHARS);
  });

  it('drops lines past the rate limit and reports how many at warn', async () => {
    const limiter = new OutputLimiter({ lines: 100, windowMs: 10_000, clock: () => 0 });
    await feed(
      Array.from({ length: 150 }, (_, i) => `line ${String(i)}\n`),
      limiter,
    );
    expect(outputs()).toHaveLength(100);
    expect(outputs()[99]).toMatchObject({ line: 'line 99' });
    expect(lines.filter((l) => l.msg === 'connector.output_dropped')).toMatchObject([
      { level: 'warn', lines: 50 },
    ]);
  });

  it('logs again in the next window and reports the drop first', async () => {
    let now = 0;
    const limiter = new OutputLimiter({ lines: 2, windowMs: 1000, clock: () => now });
    const stream = new PassThrough();
    const done = pipeLines(stream, 'stderr', log(), limiter);
    const write = async (s: string) => {
      stream.write(s);
      await new Promise((r) => setImmediate(r));
    };
    await write('a\nb\nc\nd\n');
    now = 1000;
    await write('e\n');
    stream.end();
    await done;
    expect(lines.map((l) => [l.msg, l.line ?? l.lines])).toEqual([
      ['connector.output', 'a'],
      ['connector.output', 'b'],
      ['connector.output_dropped', 2],
      ['connector.output', 'e'],
    ]);
  });

  it('shares one limit across the streams of a process', async () => {
    const dropped: number[] = [];
    const limiter = new OutputLimiter({
      lines: 3,
      windowMs: 10_000,
      clock: () => 0,
      onDrop: (n) => dropped.push(n),
    });
    await feed(['1\n2\n'], limiter, 'stdout');
    await feed(['3\n4\n5\n'], limiter, 'stderr');
    expect(outputs().map((l) => l.line)).toEqual(['1', '2', '3']);
    expect(dropped).toEqual([1, 1]);
    expect(lines.filter((l) => l.msg === 'connector.output_dropped')).toMatchObject([{ lines: 2 }]);
  });

  it('reports a drop at the end of its window when the process has gone quiet', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new OutputLimiter({ lines: 1, windowMs: 1000 });
      const stream = new PassThrough();
      void pipeLines(stream, 'stderr', log(), limiter);
      stream.write('a\nb\nc\n');
      await vi.advanceTimersByTimeAsync(10);
      expect(lines.map((l) => l.msg)).toEqual(['connector.output']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(lines.filter((l) => l.msg === 'connector.output_dropped')).toMatchObject([
        { level: 'warn', lines: 2 },
      ]);
      stream.end();
      await vi.advanceTimersByTimeAsync(10);
      expect(lines.filter((l) => l.msg === 'connector.output_dropped')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves at once for a missing stream', async () => {
    await expect(pipeLines(undefined, 'stdout', log())).resolves.toBeUndefined();
  });
});
