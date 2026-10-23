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
    if (code !== 'ESRCH' && code !== 'EPERM') {
      throw err;
    }
  }
}
