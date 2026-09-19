import { z } from 'zod';

import { ShellAction } from '../actions/shell.js';
import { DURATION } from './duration.js';
import {
  validateCron,
  validateJmespath,
  validateTimezone,
  validateTypePattern,
} from './validators.js';

const NAME = /^[a-z][a-z0-9_]*$/;
const OWN_LIFECYCLE = /^task\.([a-z][a-z0-9_]*)\.(succeeded|failed)$/;

export const CronTrigger = z
  .strictObject({
    kind: z.literal('cron'),
    schedule: z.string().min(1),
    /** `skip` (default): no new run while one for this task is queued, running or waiting. */
    overlap: z.enum(['skip', 'allow']).default('skip'),
    tz: z.string().optional(),
  })
  .superRefine((t, ctx) => {
    const tzError = validateTimezone(t.tz);
    if (tzError !== null) {
      ctx.addIssue({ code: 'custom', path: ['tz'], message: tzError });
      return;
    }
    const cronError = validateCron(t.schedule, t.tz);
    if (cronError !== null) {
      ctx.addIssue({ code: 'custom', path: ['schedule'], message: cronError });
    }
  });

export const EventTrigger = z
  .strictObject({
    kind: z.literal('event'),
    type: z.string().optional(),
    type_any: z.array(z.string()).min(1).optional(),
    /** JMESPath evaluated against the whole event (`payload.from == '…'`). */
    filter: z.string().optional(),
  })
  .superRefine((t, ctx) => {
    if ((t.type === undefined) === (t.type_any === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'exactly one of "type" or "type_any" is required',
      });
    }
    if (t.type !== undefined) {
      const err = validateTypePattern(t.type);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['type'], message: err });
      }
    }
    t.type_any?.forEach((p, i) => {
      const err = validateTypePattern(p);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['type_any', i], message: err });
      }
    });
    if (t.filter !== undefined) {
      const err = validateJmespath(t.filter);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['filter'], message: `invalid JMESPath: ${err}` });
      }
    }
  });

/** No automatic trigger. The task can still be started with `oa run <task>`. */
export const ManualTrigger = z.strictObject({ kind: z.literal('manual') });

export const Trigger = z.discriminatedUnion('kind', [CronTrigger, EventTrigger, ManualTrigger]);

/**
 * Each action kind is validated by the schema its runner exports; kinds without a runner
 * yet are checked for `kind` only.
 */
export const Action = z.discriminatedUnion('kind', [
  ShellAction,
  z.looseObject({ kind: z.enum(['connector', 'llm', 'agent', 'wait', 'sequence']) }),
]);

export const Task = z
  .strictObject({
    name: z.string().regex(NAME, 'task names are [a-z][a-z0-9_]*'),
    trigger: Trigger,
    action: Action,
    concurrency: z.number().int().positive().default(1),
    timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').optional(),
    retry: z.unknown().optional(),
    budget: z.unknown().optional(),
    on_failure: z.unknown().optional(),
    emit: z.array(z.unknown()).optional(),
    state_updates: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((task, ctx) => {
    if (task.trigger.kind !== 'event') {
      return;
    }
    const patterns =
      task.trigger.type !== undefined ? [task.trigger.type] : (task.trigger.type_any ?? []);
    patterns.forEach((p, i) => {
      const m = OWN_LIFECYCLE.exec(p);
      if (m?.[1] === task.name) {
        ctx.addIssue({
          code: 'custom',
          path:
            task.trigger.kind === 'event' && task.trigger.type !== undefined
              ? ['trigger', 'type']
              : ['trigger', 'type_any', i],
          message: `a task never triggers on its own "${p}" event`,
        });
      }
    });
  });

export const TasksFile = z.strictObject({ tasks: z.array(Task).min(1) }).superRefine((f, ctx) => {
  const seen = new Map<string, number>();
  f.tasks.forEach((t, i) => {
    const first = seen.get(t.name);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', i, 'name'],
        message: `duplicate task name "${t.name}" (first defined at tasks[${String(first)}])`,
      });
    } else {
      seen.set(t.name, i);
    }
  });
});

export type CronTriggerConfig = z.infer<typeof CronTrigger>;
export type EventTriggerConfig = z.infer<typeof EventTrigger>;
export type ManualTriggerConfig = z.infer<typeof ManualTrigger>;
export type TriggerConfig = z.infer<typeof Trigger>;
export type TaskConfig = z.infer<typeof Task>;
export type TasksFileConfig = z.infer<typeof TasksFile>;
