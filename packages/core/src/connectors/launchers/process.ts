import { setTimeout as sleep } from 'node:timers/promises';

import { execa } from 'execa';

import { errorMessage } from '../../errors.js';
import { exitOf, killGroup, releasePipes, sweepGroupAfter } from '../../process-group.js';
import { pipeLines } from '../output.js';
import { childCommand, type Launched, type Launcher, type LaunchRequest } from './index.js';

/** How long a stopped process gets after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5000;

/**
 * SIGTERM, then SIGKILL past the grace period; resolves once `exited` has. Shared by the
 * launchers whose connector is a process the core signals.
 */
export async function stopProcess(proc: {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  readonly exited: Promise<unknown>;
}): Promise<void> {
  if (proc.pid === undefined) {
    return;
  }
  proc.kill('SIGTERM');
  const done = await Promise.race([proc.exited.then(() => true), sleep(STOP_GRACE_MS, false)]);
  if (!done) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

/**
 * A `transport: none` connector: a plain process to watch and stop, its stdout and stderr
 * logged line by line.
 */
export const processLauncher: Launcher = {
  launch: (req) => Promise.resolve(req).then(start),
};

function start(req: LaunchRequest): Launched {
  const { command, args, env } = childCommand(req);
  const cwd = req.manifest.cwd;
  const child = execa(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env,
    extendEnv: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Logged line by line and dropped: a buffer would hit execa's maxBuffer and kill it.
    buffer: false,
    reject: false,
    // Its own process group, so a stop reaches what a wrapper started too (#196).
    detached: true,
  });
  // On the exit, not execa's result, which waits for pipes a helper can hold (#198),
  // and the pipes are released, even from a helper outside the group (#200).
  const ended = sweepGroupAfter(child.pid, exitOf(child))
    .then(() => releasePipes(child))
    .then(() => child)
    .then(
      (r) =>
        r.exitCode === undefined
          ? `killed by ${r.signal ?? '?'}`
          : `exit code ${String(r.exitCode)}`,
      (err: unknown) => errorMessage(err),
    );
  const limiter = req.outputLimiter();
  void pipeLines(child.stdout, 'stdout', req.log, limiter);
  void pipeLines(child.stderr, 'stderr', req.log, limiter);
  const launched: Launched = {
    pid: child.pid ?? null,
    client: undefined,
    acp: undefined,
    ended,
    stop: () =>
      stopProcess({
        pid: child.pid,
        kill: (signal) => {
          if (child.pid !== undefined) {
            killGroup(child.pid, signal);
          }
        },
        exited: ended,
      }),
  };
  return launched;
}
