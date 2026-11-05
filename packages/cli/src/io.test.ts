import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { exitOnClosedPipe } from './io.js';

function pipeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

describe('exitOnClosedPipe', () => {
  it('exits quietly with the SIGPIPE status 141 when the reader closes the pipe (EPIPE)', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout, stderr], exit);

    stdout.emit('error', pipeError('EPIPE'));

    expect(exit).toHaveBeenCalledWith(141);
  });

  it('also covers stderr', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout, stderr], exit);

    stderr.emit('error', pipeError('EPIPE'));

    expect(exit).toHaveBeenCalledWith(141);
  });

  it('rethrows any other stream error', () => {
    const stdout = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout], exit);

    expect(() => stdout.emit('error', pipeError('EIO'))).toThrow('write EIO');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('oa with a closed output pipe', () => {
  it('stops with status 141 and no stack trace when the reader goes away (#109)', async () => {
    const main = new URL('../dist/main.js', import.meta.url).pathname;
    const example = new URL('../../../docs/examples/website-updates.yaml', import.meta.url)
      .pathname;
    // Enough output to overflow the pipe buffer, so oa is still writing when the reader leaves.
    const child = spawn(
      process.execPath,
      [main, 'validate', ...Array<string>(1000).fill(example)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.once('data', () => child.stdout.destroy());
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

    expect(stderr).toBe('');
    expect(code).toBe(141);
  }, 30_000);
});
