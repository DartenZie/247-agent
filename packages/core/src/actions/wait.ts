import { z } from 'zod';

import { DURATION, parseDuration } from '../config/duration.js';
import { validateTemplate, validateTypePattern } from '../config/validators.js';
import { renderFilter } from '../expr/filter-template.js';
import { collectTemplateRefs } from '../expr/template.js';
import type { EventRecord, JsonValue } from '../store/types.js';
import { NonRetryableError, type ActionContext, type ResumeInfo } from './types.js';

/**
 * docs/internal/actions.md. The run goes to `waiting` until an event of `for.type` (a pattern)
 * passes `for.filter` (a JMESPath over the event, templated first: `${event.correlation_id}`
 * is the *current* run's event, and every value lands as data, `expr/filter-template.ts`)
 * or `timeout` elapses. The wait survives restarts. The rendered filter is written to the
 * wait record, so `secrets` are refused in it.
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
        } else if (collectTemplateRefs(f.filter).roots.has('secrets')) {
          ctx.addIssue({
            code: 'custom',
            path: ['filter'],
            message: 'secrets cannot be used here: the rendered filter is written to the store',
          });
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
      filter: cfg.for.filter === undefined ? undefined : renderFilter(cfg.for.filter, ctx.scope),
      timeoutMs: cfg.timeout === undefined ? undefined : parseDuration(cfg.timeout),
      on_timeout: cfg.on_timeout,
    },
    { step: 0, steps: [] },
  );
}
