import { spawn } from 'node:child_process';

import type { Logger } from './log.js';

/**
 * sd_notify(3) for the daemon (docs/internal/packaging.md): `READY=1` once the config is
 * loaded, the database open and the socket bound, `WATCHDOG=1` from a timer on the event
 * loop, `STOPPING=1` on shutdown. Node cannot send a datagram on a Unix socket, so each
 * message is a `systemd-notify` child; the unit therefore has `NotifyAccess=all`. Outside
 * systemd (no `NOTIFY_SOCKET`) every call does nothing.
 */
export interface SystemdNotifier {
  readonly enabled: boolean;
  /** The ping interval, or `undefined` when systemd set no watchdog for this process. */
  readonly watchdogMs: number | undefined;
  ready(): void;
  stopping(): void;
  /** Pings `WATCHDOG=1` every third of `WatchdogSec=`; a blocked event loop misses them. */
  startWatchdog(): void;
  stopWatchdog(): void;
}

export type NotifySpawn = (args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;

export interface SystemdNotifierOptions {
  log: Logger;
  /** Runs `systemd-notify <args>`; resolves with its exit code (tests replace it). */
  spawn?: NotifySpawn;
  pid?: number;
}

const spawnNotify: NotifySpawn = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn('systemd-notify', args, { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code);
    });
  });

/**
 * Reads `NOTIFY_SOCKET`, `WATCHDOG_USEC` and `WATCHDOG_PID` and deletes them from `env`, so
 * no task, connector or agent the daemon spawns can report for it (sd_notify's
 * `unset_environment`). Call it before anything reads `env` for a child.
 */
export function systemdNotifier(
  env: NodeJS.ProcessEnv,
  opts: SystemdNotifierOptions,
): SystemdNotifier {
  const socket = env.NOTIFY_SOCKET;
  const usec = Number(env.WATCHDOG_USEC);
  const watchdogPid = env.WATCHDOG_PID;
  const path = env.PATH;
  delete env.NOTIFY_SOCKET;
  delete env.WATCHDOG_USEC;
  delete env.WATCHDOG_PID;
  const pid = opts.pid ?? process.pid;
  const enabled = socket !== undefined && socket !== '';
  const forUs = watchdogPid === undefined || watchdogPid === '' || Number(watchdogPid) === pid;
  const watchdogMs =
    enabled && forUs && Number.isFinite(usec) && usec > 0
      ? Math.max(1, Math.floor(usec / 3000))
      : undefined;
  const run = opts.spawn ?? spawnNotify;
  const childEnv: NodeJS.ProcessEnv = {
    NOTIFY_SOCKET: socket,
    PATH: path ?? '/usr/local/bin:/usr/bin:/bin',
  };
  let warned = false;
  let timer: NodeJS.Timeout | undefined;

  const send = (message: string): void => {
    if (!enabled) {
      return;
    }
    run([message], childEnv).then(
      (code) => {
        if (code !== 0 && !warned) {
          warned = true;
          opts.log.warn('systemd.notify_failed', { message, exit_code: code });
        }
      },
      (err: unknown) => {
        if (!warned) {
          warned = true;
          opts.log.warn('systemd.notify_failed', {
            message,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };

  return {
    enabled,
    watchdogMs,
    ready: () => {
      send('READY=1');
    },
    stopping: () => {
      send('STOPPING=1');
    },
    startWatchdog: () => {
      if (watchdogMs === undefined || timer !== undefined) {
        return;
      }
      send('WATCHDOG=1');
      timer = setInterval(() => {
        send('WATCHDOG=1');
      }, watchdogMs);
      timer.unref();
    },
    stopWatchdog: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
