import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './log.js';
import { systemdNotifier, type NotifySpawn } from './systemd.js';

const PID = 4242;

function setup(env: NodeJS.ProcessEnv, spawn?: NotifySpawn) {
  const sent: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const lines: Record<string, unknown>[] = [];
  const notifier = systemdNotifier(env, {
    log: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
    pid: PID,
    spawn:
      spawn ??
      ((args, childEnv) => {
        sent.push({ args, env: childEnv });
        return Promise.resolve(0);
      }),
  });
  return { notifier, sent, lines };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('systemdNotifier', () => {
  it('does nothing outside systemd', () => {
    const { notifier, sent } = setup({ PATH: '/usr/bin' });
    notifier.ready();
    notifier.startWatchdog();
    notifier.stopping();
    expect(notifier).toMatchObject({ enabled: false, watchdogMs: undefined });
    expect(sent).toEqual([]);
  });

  it('takes the notify variables out of the environment children inherit', () => {
    const env = {
      PATH: '/usr/bin',
      NOTIFY_SOCKET: '/run/systemd/notify',
      WATCHDOG_USEC: '60000000',
      WATCHDOG_PID: String(PID),
    };
    const { notifier, sent } = setup(env);
    expect(env).toEqual({ PATH: '/usr/bin' });
    notifier.ready();
    notifier.stopping();
    expect(sent).toEqual([
      { args: ['READY=1'], env: { NOTIFY_SOCKET: '/run/systemd/notify', PATH: '/usr/bin' } },
      { args: ['STOPPING=1'], env: { NOTIFY_SOCKET: '/run/systemd/notify', PATH: '/usr/bin' } },
    ]);
  });

  it('pings the watchdog every third of WatchdogSec from the event loop', () => {
    vi.useFakeTimers();
    const { notifier, sent } = setup({
      NOTIFY_SOCKET: '/run/systemd/notify',
      WATCHDOG_USEC: '60000000',
      WATCHDOG_PID: String(PID),
    });
    expect(notifier.watchdogMs).toBe(20_000);
    notifier.startWatchdog();
    notifier.startWatchdog();
    expect(sent.map((s) => s.args)).toEqual([['WATCHDOG=1']]);
    vi.advanceTimersByTime(40_000);
    expect(sent.map((s) => s.args)).toEqual([['WATCHDOG=1'], ['WATCHDOG=1'], ['WATCHDOG=1']]);
    notifier.stopWatchdog();
    vi.advanceTimersByTime(40_000);
    expect(sent).toHaveLength(3);
  });

  it('leaves a watchdog meant for another process alone', () => {
    const { notifier } = setup({
      NOTIFY_SOCKET: '/run/systemd/notify',
      WATCHDOG_USEC: '60000000',
      WATCHDOG_PID: '1',
    });
    expect(notifier).toMatchObject({ enabled: true, watchdogMs: undefined });
  });

  it('warns once per failing message until it succeeds again', async () => {
    let code = 1;
    const { notifier, lines } = setup({ NOTIFY_SOCKET: '/run/systemd/notify' }, () =>
      Promise.resolve(code),
    );
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const warnings = () => lines.filter((l) => l.msg === 'systemd.notify_failed').length;
    notifier.ready();
    notifier.ready();
    notifier.stopping();
    await tick();
    expect(warnings()).toBe(2);
    code = 0;
    notifier.ready();
    await tick();
    code = 1;
    notifier.ready();
    await tick();
    expect(warnings()).toBe(3);
  });

  it('warns once when systemd-notify is missing', async () => {
    const { notifier, lines } = setup({ NOTIFY_SOCKET: '/run/systemd/notify' }, () =>
      Promise.reject(new Error('spawn systemd-notify ENOENT')),
    );
    notifier.ready();
    notifier.ready();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.filter((l) => l.msg === 'systemd.notify_failed')).toEqual([
      expect.objectContaining({ message: 'READY=1', error: 'spawn systemd-notify ENOENT' }),
    ]);
  });
});
