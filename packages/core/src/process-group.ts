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
