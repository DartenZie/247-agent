/** Injectable time source so tests can pin `now`. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Injectable one-shot timer: calls `fn` after `ms` and returns a function that cancels it.
 * Tests pass a manual one to fire delays by hand instead of sleeping.
 */
export type SetTimer = (fn: () => void, ms: number) => () => void;

/** `setTimeout`, unref'd so a pending timer never keeps the process alive. */
export const systemTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => {
    clearTimeout(t);
  };
};
