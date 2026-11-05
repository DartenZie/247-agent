/**
 * SIGHUP for `main.ts`: listened for from the start of `main`, so a reload signal that
 * arrives while the daemon is still starting does not hit Node's default action (exit).
 * Until `start` a SIGHUP is only remembered; `start` then reloads once, because the files
 * may have changed after startup read them. After `start` every SIGHUP reloads.
 */
export interface SignalSource {
  on(signal: 'SIGHUP', listener: () => void): unknown;
  removeListener(signal: 'SIGHUP', listener: () => void): unknown;
}

export interface ReloadSignal {
  /** The daemon is up: replay a SIGHUP from startup, then reload on each one. */
  start(reload: () => void): void;
  /** Startup failed: stop listening. */
  cancel(): void;
}

export function listenForReload(
  source: SignalSource,
  opts: { onDeferred?: () => void } = {},
): ReloadSignal {
  let reload: (() => void) | undefined;
  let pending = false;
  const listener = (): void => {
    if (reload === undefined) {
      pending = true;
      opts.onDeferred?.();
      return;
    }
    reload();
  };
  source.on('SIGHUP', listener);
  return {
    start(fn) {
      reload = fn;
      if (pending) {
        pending = false;
        fn();
      }
    },
    cancel() {
      source.removeListener('SIGHUP', listener);
    },
  };
}
