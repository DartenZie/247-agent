import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { exitOnClosedPipe } from './io.js';

function pipeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

describe('exitOnClosedPipe', () => {
  it('exits quietly with code 0 when the reader closes the pipe (EPIPE)', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout, stderr], exit);

    stdout.emit('error', pipeError('EPIPE'));

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('also covers stderr', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout, stderr], exit);

    stderr.emit('error', pipeError('EPIPE'));

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('rethrows any other stream error', () => {
    const stdout = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe([stdout], exit);

    expect(() => stdout.emit('error', pipeError('EIO'))).toThrow('write EIO');
    expect(exit).not.toHaveBeenCalled();
  });
});
