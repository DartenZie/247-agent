import { execa } from 'execa';
import { z } from 'zod';

import type { JsonValue } from '../store/types.js';
import type { ActionContext } from './types.js';

/** ARCHITECTURE §5.1. `${…}` templating and `user:` are not applied yet: values run as written. */
export const ShellAction = z.strictObject({
  kind: z.literal('shell'),
  /** argv; no shell unless you spell it out (`["bash", "-c", "…"]`). */
  cmd: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  /** Added to the daemon's environment. */
  env: z.record(z.string(), z.string()).optional(),
  /** Written to stdin: strings verbatim, anything else as JSON. */
  stdin: z.unknown().optional(),
  result: z.enum(['json_stdout', 'text_stdout', 'exit_code']).default('text_stdout'),
});

export type ShellActionConfig = z.infer<typeof ShellAction>;

/** Bytes of stdout/stderr kept per stream; the rest is discarded, not buffered. */
const MAX_BUFFER = 8 * 1024 * 1024;
/** Length of the stderr excerpt that goes into the run's error message. */
const ERROR_TAIL = 1024;
/** After SIGTERM on abort, SIGKILL if the process is still around. */
const FORCE_KILL_AFTER_MS = 5000;

export class ShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ShellError';
  }
}

function tail(text: string): string {
  const t = text.trimEnd();
  return t.length <= ERROR_TAIL ? t : '…' + t.slice(-ERROR_TAIL);
}

function withTail(message: string, stderr: string): string {
  const t = tail(stderr);
  return t === '' ? message : `${message}: ${t}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('cancelled');
}

/**
 * Runs `cmd` as a subprocess and turns its outcome into the run result per `result`:
 * `text_stdout` (trailing newline removed), `json_stdout` (parsed; invalid JSON fails the
 * run) or `exit_code` (the number; a non-zero exit is then a result, not a failure).
 * In the other modes a non-zero exit, a signal or a spawn error fails the run with the
 * exit code and the tail of stderr. Aborting `ctx.signal` kills the process.
 */
export async function runShell(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = ShellAction.parse(action);
  const [file, ...args] = cfg.cmd;
  if (file === undefined) {
    throw new ShellError('cmd is empty', undefined, ''); // unreachable: schema requires one
  }
  if (ctx.signal.aborted) {
    throw abortReason(ctx.signal);
  }
  const input =
    cfg.stdin === undefined
      ? undefined
      : typeof cfg.stdin === 'string'
        ? cfg.stdin
        : JSON.stringify(cfg.stdin);

  const startedAt = Date.now();
  const subprocess = execa(file, args, {
    ...(cfg.cwd === undefined ? {} : { cwd: cfg.cwd }),
    ...(cfg.env === undefined ? {} : { env: cfg.env }),
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_BUFFER,
    reject: false,
    stripFinalNewline: false,
  });

  // Not execa's `cancelSignal`: when the spawn itself failed the child has no pid and
  // Node's `kill()` then signals pid 0, i.e. our whole process group. Guard on `pid`.
  let abortedBy: Error | undefined;
  const onAbort = (): void => {
    abortedBy = abortReason(ctx.signal);
    if (subprocess.pid === undefined) {
      return;
    }
    subprocess.kill('SIGTERM');
    setTimeout(() => {
      if (subprocess.exitCode === null && subprocess.signalCode === null) {
        subprocess.kill('SIGKILL');
      }
    }, FORCE_KILL_AFTER_MS).unref();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let proc;
  try {
    proc = await subprocess;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }

  ctx.log.info('shell.exited', {
    exit_code: proc.exitCode ?? null,
    signal: proc.signal ?? null,
    duration_ms: Date.now() - startedAt,
    stdout_bytes: Buffer.byteLength(proc.stdout),
    stderr_bytes: Buffer.byteLength(proc.stderr),
  });

  if (abortedBy !== undefined) {
    // The executor aborted us (timeout or shutdown); its reason names why.
    throw abortedBy;
  }
  if (proc.exitCode === undefined) {
    // Spawn failure (ENOENT, EACCES, bad cwd) or killed by a signal from elsewhere.
    const why =
      proc.signal === undefined
        ? (proc.originalMessage ?? proc.shortMessage ?? 'process failed to start')
        : `killed by ${proc.signal}`;
    throw new ShellError(withTail(why, proc.stderr), undefined, proc.stderr);
  }
  if (cfg.result === 'exit_code') {
    return proc.exitCode;
  }
  if (proc.exitCode !== 0) {
    throw new ShellError(
      withTail(`exit code ${String(proc.exitCode)}`, proc.stderr),
      proc.exitCode,
      proc.stderr,
    );
  }
  if (cfg.result === 'json_stdout') {
    try {
      return JSON.parse(proc.stdout) as JsonValue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ShellError(`stdout is not JSON: ${msg}`, proc.exitCode, proc.stderr);
    }
  }
  return proc.stdout.replace(/\r?\n$/, '');
}
