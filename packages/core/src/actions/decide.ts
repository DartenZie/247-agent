import { z } from 'zod';

import { Budget } from '../llm/config.js';
import type { DecideAnswer, DecideQuestion, DecideState } from '../llm/types.js';
import type { JsonValue } from '../store/types.js';
import { NonRetryableError, type ActionContext } from './types.js';

const NAME = /^[a-z][a-z0-9_]*$/;
const text = z.string().min(1);

/** Jev accepts up to 255 labels; more than a handful of score levels stops being ordinal. */
const MAX_CHOICES = 255;
const MAX_LEVELS = 10;

const NoulQuestion = z.strictObject({
  type: z.literal('noul'),
  instructions: text,
  /** Both sides or neither: the Decisions API rejects a one-sided object. */
  criteria: z.strictObject({ true: text, false: text }).optional(),
});

const ChoiceQuestion = z.strictObject({
  type: z.literal('choice'),
  instructions: text,
  criteria: z
    .record(text, text)
    .refine((c) => Object.keys(c).length >= 2, 'a choice needs at least two labels')
    .refine(
      (c) => Object.keys(c).length <= MAX_CHOICES,
      `a choice takes at most ${String(MAX_CHOICES)} labels`,
    ),
});

const ScoreQuestion = z.strictObject({
  type: z.literal('score'),
  instructions: text,
  /** Ordered, index 0 the lowest level. */
  criteria: z.array(text).min(2).max(MAX_LEVELS),
});

export const DecideQuestionSchema = z.discriminatedUnion('type', [
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
]);

/**
 * ARCHITECTURE §5.3: one Decisions API call (TypeSafe's Jev via an `openrouter` provider),
 * typed answers with probabilities, no text. `state` is templated; the questions are static
 * policy, so a `${…}` in them is refused the way `llm` refuses a templated system prompt.
 */
export const DecideAction = z
  .strictObject({
    kind: z.literal('decide'),
    provider: z.string().regex(NAME, 'provider names are [a-z][a-z0-9_]*').optional(),
    model: z.string().min(1).optional(),
    /** Templated; a string, or an object/array whose strings are rendered (keys never are). */
    state: z.union([text, z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    questions: z
      .record(z.string().regex(NAME, 'question ids are [a-z][a-z0-9_]*'), DecideQuestionSchema)
      .refine((q) => Object.keys(q).length >= 1, 'at least one question is required'),
    budget: Budget.optional(),
  })
  .superRefine((a, ctx) => {
    const message = 'questions are static policy; put dynamic content in "state"';
    for (const [id, q] of Object.entries(a.questions)) {
      if (q.instructions.includes('${')) {
        ctx.addIssue({ code: 'custom', path: ['questions', id, 'instructions'], message });
      }
      const criteria =
        q.criteria === undefined
          ? []
          : Array.isArray(q.criteria)
            ? q.criteria
            : Object.entries(q.criteria).flat();
      if (criteria.some((s) => s.includes('${'))) {
        ctx.addIssue({ code: 'custom', path: ['questions', id, 'criteria'], message });
      }
    }
  });

export type DecideActionConfig = z.infer<typeof DecideAction>;

export async function runDecide(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = DecideAction.parse(action);
  const llm = ctx.llm;
  if (llm === undefined) {
    throw new NonRetryableError('no llm service is configured');
  }
  const provider = cfg.provider ?? llm.decideDefaults.provider;
  if (provider === undefined) {
    throw new NonRetryableError('no provider: set action.provider or defaults.decide.provider');
  }
  const model = cfg.model ?? llm.decideDefaults.model;
  const state = renderedState(ctx.render(cfg.state));
  const caps = [cfg.budget?.max_usd, ctx.task.budget?.max_usd].filter((x) => x !== undefined);
  const maxUsd = caps.length === 0 ? undefined : Math.min(...caps);
  const questions: Record<string, DecideQuestion> = cfg.questions;
  const res = await llm.decide(
    { provider, model, state, questions, maxUsd },
    { run: ctx.run, task: ctx.task.name, signal: ctx.signal, log: ctx.log },
  );
  return checkAnswers(questions, res.answers) as JsonValue;
}

/** A whole-string template can render to anything; the API takes text or a JSON document. */
function renderedState(value: unknown): DecideState {
  if (typeof value === 'string') {
    if (value === '') {
      throw new NonRetryableError('state rendered to an empty string');
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    return value as DecideState;
  }
  throw new NonRetryableError(
    `state rendered to ${value === null ? 'null' : typeof value}; it must be a string, an object or an array`,
  );
}

/**
 * Every configured question answered, with the configured type and a value inside the
 * configured criteria. A mismatch is the provider's fault and retryable (the next attempt may
 * answer properly); extra answers are dropped so the result is exactly what the task declared.
 */
function checkAnswers(
  questions: Record<string, DecideQuestion>,
  answers: Record<string, DecideAnswer>,
): Record<string, DecideAnswer> {
  const out: Record<string, DecideAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (a === undefined) {
      throw new Error(`the decision has no answer for question "${id}"`);
    }
    if (a.type !== q.type) {
      throw new Error(`question "${id}" is a ${q.type} but was answered as ${a.type}`);
    }
    switch (a.type) {
      case 'noul':
        if (typeof a.noul !== 'number') {
          throw new Error(`question "${id}": noul is not a number`);
        }
        break;
      case 'choice':
        if (q.type === 'choice' && !Object.hasOwn(q.criteria, a.choice)) {
          throw new Error(
            `question "${id}": choice "${a.choice}" is not one of ${Object.keys(q.criteria).join(', ')}`,
          );
        }
        break;
      case 'score':
        if (
          q.type === 'score' &&
          (typeof a.score !== 'number' || a.score < 0 || a.score > q.criteria.length - 1)
        ) {
          throw new Error(
            `question "${id}": score ${String(a.score)} is outside 0..${String(q.criteria.length - 1)}`,
          );
        }
        break;
    }
    out[id] = a;
  }
  return out;
}
