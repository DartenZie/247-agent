import { Cron } from 'croner';

import { validateTypePattern as validatePattern } from '../expr/glob.js';
import { validateJmespath as validateJmes } from '../expr/jmespath.js';

/**
 * Pure semantic checks run from zod refinements. Each returns an error message or null.
 */

export function validateTimezone(tz: string | undefined): string | null {
  if (tz === undefined) {
    return null;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return null;
  } catch {
    return `unknown time zone "${tz}"`;
  }
}

export function validateCron(schedule: string, tz: string | undefined): string | null {
  let job: Cron;
  try {
    // No callback, so croner parses without arming a timer.
    job = tz === undefined ? new Cron(schedule) : new Cron(schedule, { timezone: tz });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const next = job.nextRun();
  job.stop();
  if (next === null) {
    return `schedule "${schedule}" never fires`;
  }
  return null;
}

/** A trigger pattern: may contain `*` segments. */
export function validateTypePattern(pattern: string): string | null {
  return validatePattern(pattern, { allowWildcard: true });
}

/** A concrete event type as emitted by a publisher: no wildcards. */
export function validateEventType(type: string): string | null {
  return validatePattern(type, { allowWildcard: false });
}

export function validateJmespath(expr: string): string | null {
  return validateJmes(expr);
}
