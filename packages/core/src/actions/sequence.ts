import { z } from 'zod';

import { validateJmespath } from '../config/validators.js';
import { evaluateExpr } from '../expr/template.js';
import { isJmesTruthy } from '../expr/jmespath.js';
import type { JsonValue } from '../store/types.js';
import { ConnectorAction, runConnector } from './connector.js';
import { runShell, ShellAction } from './shell.js';
import { NonRetryableError, withScope, type ActionContext, type ActionRunner } from './types.js';
import { runWait, WaitAction, waitResult } from './wait.js';

/** JMESPath over the scope (`steps[1].payload.approved`); a falsy value skips the step. */
const WHEN = z.string().min(1).optional();

export const SequenceStep = z
  .discriminatedUnion('kind', [
    ShellAction.extend({ when: WHEN }),
    ConnectorAction.extend({ when: WHEN }),
    WaitAction.extend({ when: WHEN }),
  ])
  .superRefine((s, ctx) => {
    if (s.when !== undefined) {
      const err = validateJmespath(s.when);
      if (err !== null) {
        ctx.addIssue({ code: 'custom', path: ['when'], message: `invalid JMESPath: ${err}` });
      }
    }
  });

/**
 * docs/internal/actions.md: a few steps in one run. `steps[i]` in later steps' templates and
 * `when` is the result of step i (`null` when skipped). The run result is `{steps: [...]}`.
 * A `wait` step suspends the whole run; on resume the sequence continues from that step
 * with the earlier results restored. Each finished step is saved as progress, so a retry
 * continues after the last step that finished and never repeats a connector op.
 */
export const SequenceAction = z.strictObject({
  kind: z.literal('sequence'),
  steps: z.array(SequenceStep).min(1),
});

export type SequenceActionConfig = z.infer<typeof SequenceAction>;
export type SequenceStepConfig = z.infer<typeof SequenceStep>;

const STEP_RUNNERS: Record<SequenceStepConfig['kind'], ActionRunner> = {
  shell: runShell,
  connector: runConnector,
  wait: runWait,
};

interface Checkpoint {
  step: number;
  steps: JsonValue[];
}

function checkpointOf(data: JsonValue, what: string): Checkpoint {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof data.step === 'number' &&
    Array.isArray(data.steps)
  ) {
    return { step: data.step, steps: data.steps };
  }
  throw new NonRetryableError(`sequence ${what} data is corrupt`);
}

export async function runSequence(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = SequenceAction.parse(action);
  let start = 0;
  let results: JsonValue[] = [];
  let resume = ctx.resume;
  const waited = resume === undefined ? undefined : checkpointOf(resume.resume, 'resume');
  const saved = ctx.progress === undefined ? undefined : checkpointOf(ctx.progress, 'progress');
  // Progress past the wait means an earlier attempt already took the wait's outcome.
  const cp =
    saved !== undefined && (waited === undefined || saved.step > waited.step) ? saved : waited;
  if (cp !== undefined) {
    if (cp === saved) {
      resume = undefined;
    }
    start = cp.step;
    // Every attempt gets the same resume; a copy keeps this one's steps out of the next.
    results = [...cp.steps];
  }
  for (let i = start; i < cfg.steps.length; i++) {
    const step = cfg.steps[i];
    if (step === undefined) {
      break;
    }
    const index = i;
    const stepCtx: ActionContext = {
      ...withScope(ctx, { steps: results }),
      log: ctx.log.child({ step: index, step_kind: step.kind }),
      suspend: (spec) => ctx.suspend(spec, { step: index, steps: results }),
      resume: resume !== undefined && i === start ? resume : undefined,
    };
    // A resumed wait already passed its `when` before it suspended.
    if (stepCtx.resume === undefined && step.when !== undefined) {
      if (!isJmesTruthy(evaluateExpr(step.when, stepCtx.scope))) {
        stepCtx.log.info('step.skipped');
        results.push(null);
        ctx.saveProgress({ step: index + 1, steps: results });
        continue;
      }
    }
    const { when: _when, ...stepAction } = step;
    const result =
      stepCtx.resume !== undefined && step.kind === 'wait'
        ? waitResult(WaitAction.parse(stepAction), stepCtx.resume)
        : await STEP_RUNNERS[step.kind](stepAction, stepCtx);
    results.push(result);
    ctx.saveProgress({ step: index + 1, steps: results });
    resume = undefined;
  }
  return { steps: results };
}
