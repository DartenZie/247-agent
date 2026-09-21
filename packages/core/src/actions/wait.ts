import { z } from 'zod';

import { DURATION, parseDuration } from '../config/duration.js';
import { validateTemplate, validateTypePattern } from '../config/validators.js';
import type { EventRecord, JsonValue } from '../store/types.js';
import { NonRetryableError, type ActionContext, type ResumeInfo } from './types.js';

/**
 * ARCHITECTURE §5.6. The run goes to `waiting` until an event of `for.type` (a pattern)
 * passes `for.filter` (a JMESPath over the event, templated first: `${event.correlation_id}`
 * is the *current* run's event) or `timeout` elapses. The wait survives restarts.
 */
export const WaitAction = z.strictObject({
  kind: z.literal('wait'),
  for: z
    .strictObject({
      type: z.string().min(1),
      filter: z.string().min(1).optional(),
    })
    .superRefine((f, ctx) => {
      const typeErr = validateTypePattern(f.type);
      if (typeErr !== null) {
        ctx.addIssue({ code: 'custom', path: ['type'], message: typeErr });
      }
      if (f.filter !== undefined) {
        const err = validateTemplate(f.filter);
        if (err !== null) {
          ctx.addIssue({ code: 'custom', path: ['filter'], message: err });
        }
      }
    }),
  timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').optional(),
  on_timeout: z.enum(['fail', 'succeed']).default('fail'),
});

export type WaitActionConfig = z.infer<typeof WaitAction>;

export class WaitTimeoutError extends NonRetryableError {
  constructor(readonly type: string) {
    super(`timed out waiting for ${type}`);
    this.name = 'WaitTimeoutError';
  }
}

/** The matched event as a step result / run result: everything but the internal `seq`. */
export function eventView(event: EventRecord): Record<string, JsonValue> {
  const { seq: _seq, ...rest } = event;
  return rest;
}

/** Turns a finished wait into the runner's result, or throws on a fatal timeout. */
export function waitResult(cfg: WaitActionConfig, resume: ResumeInfo): JsonValue {
  if (resume.outcome === 'matched') {
    if (resume.event === undefined) {
      throw new NonRetryableError('wait matched but the event is gone');
    }
    return eventView(resume.event);
  }
  if (cfg.on_timeout === 'fail') {
    throw new WaitTimeoutError(cfg.for.type);
  }
  return { timed_out: true };
}

/** Standalone `wait` action; sequences call `waitResult`/`ctx.suspend` themselves. */
export async function runWait(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = WaitAction.parse(action);
  if (ctx.resume !== undefined) {
    return waitResult(cfg, ctx.resume);
  }
  return ctx.suspend(
    {
      type: cfg.for.type,
      filter: cfg.for.filter === undefined ? undefined : ctx.renderText(cfg.for.filter),
      timeoutMs: cfg.timeout === undefined ? undefined : parseDuration(cfg.timeout),
      on_timeout: cfg.on_timeout,
    },
    { step: 0, steps: [] },
  );
}
