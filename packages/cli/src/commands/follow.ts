import { setTimeout as sleep } from 'node:timers/promises';

import { ApiConnectionError } from '@247-agent/core';

import type { Io } from '../io.js';

/** How often `--follow` polls the daemon, and retries while it is away. */
export const POLL_MS = 1000;

/**
 * Whether `err` means the daemon went away (stopped, restarting, not listening yet) rather
 * than refused or failed the request: worth retrying while following.
 */
function daemonGone(err: unknown): string | undefined {
  if (err instanceof ApiConnectionError) {
    return err.code === 'EACCES' ? undefined : err.code;
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE' ? code : undefined;
}

/**
 * Returns a wrapper for the API calls of a `--follow` loop: while the daemon is away, it
 * says so once on stderr and retries every `POLL_MS` until the call succeeds or the user
 * interrupts `oa`. Callers keep their own cursor, so the retried call resumes after the
 * last item they printed. Any other error is thrown as it is.
 */
export function reconnecting(io: Io): <T>(call: () => Promise<T>) => Promise<T> {
  return async (call) => {
    let waiting = false;
    for (;;) {
      try {
        const result = await call();
        if (waiting) {
          io.err('reconnected to the daemon');
        }
        return result;
      } catch (err) {
        const code = daemonGone(err);
        if (code === undefined) {
          throw err;
        }
        if (!waiting) {
          io.err(`lost the daemon (${code}); waiting for it to come back (Ctrl-C to stop)`);
          waiting = true;
        }
        await sleep(POLL_MS);
      }
    }
  };
}
