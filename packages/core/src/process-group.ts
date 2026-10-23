import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { onExit } from 'signal-exit';

/**
 * Signals the process group `pid` leads; a group that is already gone is not an error.
 * Never called with a missing pid: `kill(-0)` would be the daemon's own group. The
 * process must have been spawned `detached`, so that it leads a group of its own.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // macOS answers EPERM for a group whose only member is a zombie not yet reaped.
    if (code !== 'ESRCH' && !(code === 'EPERM' && process.platform === 'darwin')) {
      throw err;
    }
  }
}

const live = new Set<number>();
let hooked = false;

/**
 * Puts the group `pid` leads on the list that is SIGKILLed when the daemon exits without
 * stopping it: a crash stop past its deadline, or a second SIGTERM. execa does the same
 * for a child, but not for a detached one. Returns the function that takes it off.
 */
export function killGroupOnExit(pid: number): () => void {
  if (!hooked) {
    hooked = true;
    onExit(
      () => {
        for (const group of live) {
          try {
            killGroup(group, 'SIGKILL');
          } catch {
            // the daemon is exiting; nothing is left to report it to
          }
        }
      },
      { alwaysLast: true },
    );
  }
  live.add(pid);
  return () => {
    live.delete(pid);
  };
}

/**
 * Resolves once `leaderDone` settles and the rest of the group `pid` leads is SIGKILLed:
 * a member that holds none of the leader's pipes would outlive it otherwise. Until then
 * the group is killed if the daemon exits first. `leaderDone` keeps its own outcome.
 */
export async function sweepGroupAfter(
  pid: number | undefined,
  leaderDone: Promise<unknown>,
): Promise<void> {
  const release = pid === undefined ? undefined : killGroupOnExit(pid);
  try {
    await leaderDone;
  } catch {
    // the caller reads the outcome from `leaderDone` itself
  } finally {
    if (pid !== undefined) {
      killGroup(pid, 'SIGKILL');
      release?.();
    }
  }
}

/**
 * Resolves when `child` exits or cannot be spawned. Unlike its `close` event, or an execa
 * result, it does not wait for the pipes: another member of the group, such as a helper a
 * wrapper started in the background, can hold them open long after the program is gone (#198).
 * A child without a pid never started: execa answers a spawn that throws with one that
 * emits neither `exit` nor `error`.
 */
export function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
}

/**
 * Waits up to `graceMs` for `child`'s stdout and stderr to close, then destroys our end of
 * every pipe still open. Called once the child has exited and its group is swept: what
 * holds a pipe then is a process that left the group, such as a helper started with
 * `setsid`, which no group signal reaches and which may never exit (#200). The grace lets
 * the last output of the child drain.
 */
export async function releasePipes(child: ChildProcess, graceMs = 1000): Promise<void> {
  const open = [child.stdout, child.stderr].filter(
    (s): s is NonNullable<typeof s> => s !== null && !s.closed,
  );
  if (open.length > 0) {
    await Promise.race([
      Promise.all(open.map((s) => once(s, 'close').catch(() => undefined))),
      sleep(graceMs, undefined, { ref: false }),
    ]);
  }
  for (const s of [child.stdin, child.stdout, child.stderr]) {
    s?.destroy();
  }
}
