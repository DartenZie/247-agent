import { z } from 'zod';

import { ConnectorAction } from '../actions/connector.js';
import { SequenceAction } from '../actions/sequence.js';
import { ShellAction } from '../actions/shell.js';
import { WaitAction } from '../actions/wait.js';
import { collectTemplateRefs } from '../expr/template.js';
import { DURATION } from './duration.js';
import {
  validateCron,
  validateEventType,
  validateJmespath,
  validateTemplate,
  validateTimezone,
  validateTypePattern,
} from './validators.js';

const NAME = /^[a-z][a-z0-9_]*$/;
const OWN_LIFECYCLE = /^task\.([a-z][a-z0-9_]*)\.(succeeded|failed)$/;
const STATE_KEY = /^[a-z0-9_-]+\.[a-z0-9_-]+$/;

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
 * yet (`llm`, `agent`) are checked for `kind` only.
 */
export const Action = z.discriminatedUnion('kind', [
  ShellAction,
  ConnectorAction,
  WaitAction,
  SequenceAction,
  z.looseObject({ kind: z.enum(['llm', 'agent']) }),
]);

/** ARCHITECTURE §5.7: one domain event (or one per `each` item) after a successful run. */
export const EmitRule = z
  .strictObject({
    type: z.string().min(1),
    /** JMESPath over `{event, result, state, env, run}`; a falsy value skips the rule. */
    when: z.string().min(1).optional(),
    /** A whole `${…}` template that renders to an array; one event per `item`. */
    each: z.string().min(1).optional(),
    dedup_key: z.string().min(1).optional(),
    payload: z.unknown().optional(),
  })
  .superRefine((r, ctx) => {
    const typeErr = validateEventType(r.type);
    if (typeErr !== null) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: typeErr });
    }
    if (r.when !== undefined) {
      const err = validateJmespath(r.when);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['when'], message: `invalid JMESPath: ${err}` });
      }
    }
    if (r.each !== undefined) {
      const err = validateTemplate(r.each);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['each'], message: err });
      } else if (!/^\s*\$\{[\s\S]*\}\s*$/.test(r.each)) {
        ctx.addIssue({
          code: 'custom',
          path: ['each'],
          message: 'each must be a single ${…} template that renders to an array',
        });
      }
    }
  });

/** ARCHITECTURE §10. Retries are attempts of the same run; `task.<name>.failed` fires after the last. */
export const Retry = z.strictObject({
  attempts: z.number().int().min(1).max(100).default(1),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  base: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').default('30s'),
  max: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').default('1h'),
});

export type RetryConfig = z.infer<typeof Retry>;

/** Adds issues for templates that reference `secrets` or do not compile. */
function checkTemplates(
  value: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
  opts: { secrets: boolean },
): void {
  const refs = collectTemplateRefs(value);
  for (const e of refs.errors) {
    ctx.addIssue({ code: 'custom', path, message: `${e.message} (in "${e.template}")` });
  }
  for (const t of refs.wholeSecrets) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `reference secrets by name (secrets.<name>), not as a whole (in "${t}")`,
    });
  }
  if (!opts.secrets && refs.roots.has('secrets')) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: 'secrets cannot be used here: they would be written to the store or an event',
    });
  }
}

export const Task = z
  .strictObject({
    name: z.string().regex(NAME, 'task names are [a-z][a-z0-9_]*'),
    trigger: Trigger,
    action: Action,
    concurrency: z.number().int().positive().default(1),
    /** Wall-clock limit per attempt of active work; time spent `waiting` does not count. */
    timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').optional(),
    /** Overrides `defaults.retry` from agent.yaml. */
    retry: Retry.optional(),
    budget: z.unknown().optional(),
    on_failure: z.unknown().optional(),
    emit: z.array(EmitRule).optional(),
    /** `<namespace>.<key>: <value or template>`, applied after a successful run. */
    state_updates: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((task, ctx) => {
    checkTemplates(task.action, ['action'], ctx, { secrets: true });
    task.emit?.forEach((rule, i) => {
      checkTemplates(
        { each: rule.each, dedup_key: rule.dedup_key, payload: rule.payload },
        ['emit', i],
        ctx,
        { secrets: false },
      );
    });
    if (task.state_updates !== undefined) {
      for (const key of Object.keys(task.state_updates)) {
        if (!STATE_KEY.test(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['state_updates', key],
            message: 'state keys are <namespace>.<key>, each [a-z0-9_-]+',
          });
        }
      }
      checkTemplates(task.state_updates, ['state_updates'], ctx, { secrets: false });
    }
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
export type EmitRuleConfig = z.infer<typeof EmitRule>;
export type TaskConfig = z.infer<typeof Task>;
export type TasksFileConfig = z.infer<typeof TasksFile>;
