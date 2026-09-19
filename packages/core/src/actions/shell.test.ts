import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../store/types.js';
import { runShell, ShellAction, ShellError } from './shell.js';
import { testContext } from './testing.js';
import type { ActionContext } from './types.js';

function ctx(signal: AbortSignal = new AbortController().signal): ActionContext {
  return testContext({ signal });
}

const run = (action: Record<string, unknown>, c = ctx()): Promise<JsonValue> =>
  runShell({ kind: 'shell', ...action }, c);

describe('ShellAction schema', () => {
  it('requires a non-empty argv and defaults result to text_stdout', () => {
    expect(ShellAction.parse({ kind: 'shell', cmd: ['true'] }).result).toBe('text_stdout');
    expect(ShellAction.safeParse({ kind: 'shell', cmd: [] }).success).toBe(false);
    expect(ShellAction.safeParse({ kind: 'shell' }).success).toBe(false);
    expect(ShellAction.safeParse({ kind: 'shell', cmd: ['x'], user: 'root' }).success).toBe(false);
  });
});

describe('runShell', () => {
  it('returns stdout without its final newline by default', async () => {
    await expect(run({ cmd: ['printf', 'hi\\n'] })).resolves.toBe('hi');
    await expect(run({ cmd: ['printf', 'a\\nb'] })).resolves.toBe('a\nb');
  });

  it('parses stdout as JSON for json_stdout', async () => {
    await expect(run({ cmd: ['echo', '{"a":[1,2]}'], result: 'json_stdout' })).resolves.toEqual({
      a: [1, 2],
    });
    await expect(run({ cmd: ['echo', 'nope'], result: 'json_stdout' })).rejects.toThrow(
      /stdout is not JSON/,
    );
  });

  it('returns the exit code, even non-zero, for exit_code', async () => {
    await expect(run({ cmd: ['sh', '-c', 'exit 3'], result: 'exit_code' })).resolves.toBe(3);
    await expect(run({ cmd: ['true'], result: 'exit_code' })).resolves.toBe(0);
  });

  it('fails on a non-zero exit with the tail of stderr', async () => {
    const err = await run({ cmd: ['sh', '-c', 'echo boom >&2; exit 2'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShellError);
    expect((err as ShellError).message).toBe('exit code 2: boom');
    expect((err as ShellError).exitCode).toBe(2);
  });

  it('writes stdin verbatim for strings and as JSON otherwise', async () => {
    await expect(run({ cmd: ['cat'], stdin: 'raw text' })).resolves.toBe('raw text');
    await expect(run({ cmd: ['cat'], stdin: { a: 1 } })).resolves.toBe('{"a":1}');
  });

  it('applies env and cwd', async () => {
    await expect(
      run({ cmd: ['sh', '-c', 'echo "$FOO $(pwd)"'], env: { FOO: 'bar' }, cwd: '/' }),
    ).resolves.toBe('bar /');
  });

  it('fails on a spawn error without touching anything else', async () => {
    await expect(run({ cmd: ['/nonexistent/binary'] })).rejects.toThrow(/ENOENT/);
    await expect(run({ cmd: ['true'], cwd: '/nonexistent/dir' })).rejects.toThrow(/ENOENT|cwd/);
  });

  it('survives an abort that arrives while the spawn is failing', async () => {
    // Regression: kill() on a child that never spawned signals pid 0 = our process group.
    const controller = new AbortController();
    const p = run({ cmd: ['true'], cwd: '/nonexistent/dir' }, ctx(controller.signal));
    controller.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
  });

  it('kills the process when the signal aborts and rethrows the reason', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = run({ cmd: ['sleep', '30'] }, ctx(controller.signal));
    setTimeout(() => {
      controller.abort(new Error('timed out'));
    }, 50);
    await expect(p).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not spawn at all when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await expect(run({ cmd: ['true'] }, ctx(controller.signal))).rejects.toThrow('already');
  });
});
