import { describe, expect, it } from 'vitest';

import { fakeLlmPort } from '../llm/testing.js';
import type { DecideAnswer, DecideCallResult } from '../llm/types.js';
import { DecideAction, runDecide } from './decide.js';
import { testContext } from './testing.js';
import { isRetryable, NonRetryableError } from './types.js';

const answers: Record<string, DecideAnswer> = {
  kind: {
    type: 'choice',
    choice: 'update',
    confidence: 0.8,
    probabilities: { update: 0.9, ignore: 0.1 },
  },
  urgent: { type: 'noul', noul: 0.97 },
  anger: { type: 'score', score: 1.05, confidence: 0.92, probabilities: { '1': 0.95, '2': 0.05 } },
};

const result = (over: Partial<DecideCallResult> = {}): DecideCallResult => ({
  answers,
  usage: { input: 476, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.00002 },
  usd: 0.00002,
  priced_by: 'provider',
  ledgerId: 1,
  ...over,
});

const questions = {
  kind: {
    type: 'choice',
    instructions: 'What does the sender want?',
    criteria: { update: 'A change to the site', ignore: 'Anything else' },
  },
  urgent: {
    type: 'noul',
    instructions: 'Is it urgent?',
    criteria: { true: 'Asks for action today', false: 'No deadline' },
  },
  anger: { type: 'score', instructions: 'How angry?', criteria: ['Calm', 'Annoyed', 'Furious'] },
};

const action = {
  kind: 'decide',
  state: { subject: '${event.payload.subject}', body: '${event.payload.body}' },
  questions,
};

describe('DecideAction schema', () => {
  it('accepts the documented shape with a string, object or array state', () => {
    expect(DecideAction.safeParse({ ...action, provider: 'router', model: 'm' }).success).toBe(
      true,
    );
    expect(DecideAction.safeParse({ ...action, state: '${event.payload.body}' }).success).toBe(
      true,
    );
    expect(DecideAction.safeParse({ ...action, state: ['a', '${event.x}'] }).success).toBe(true);
    expect(
      DecideAction.safeParse({
        ...action,
        questions: { urgent: { type: 'noul', instructions: 'x' } },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no questions', { questions: {} }],
    ['a bad question id', { questions: { Kind: questions.kind } }],
    [
      'a one-sided noul',
      { questions: { u: { type: 'noul', instructions: 'x', criteria: { true: 'y' } } } },
    ],
    [
      'a one-label choice',
      { questions: { k: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } } },
    ],
    [
      '256 labels',
      {
        questions: {
          k: {
            type: 'choice',
            instructions: 'x',
            criteria: Object.fromEntries(
              Array.from({ length: 256 }, (_, i) => [`l${String(i)}`, 'd']),
            ),
          },
        },
      },
    ],
    [
      'a one-level score',
      { questions: { s: { type: 'score', instructions: 'x', criteria: ['a'] } } },
    ],
    [
      'an eleven-level score',
      {
        questions: {
          s: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, () => 'l') },
        },
      },
    ],
    [
      'a templated instruction',
      { questions: { u: { type: 'noul', instructions: 'Is ${event.x} urgent?' } } },
    ],
    [
      'a templated criteria value',
      {
        questions: {
          k: { type: 'choice', instructions: 'x', criteria: { a: '${event.x}', b: 'b' } },
        },
      },
    ],
    [
      'a templated choice key',
      {
        questions: {
          k: { type: 'choice', instructions: 'x', criteria: { '${event.x}': 'a', b: 'b' } },
        },
      },
    ],
    ['an unknown question type', { questions: { k: { type: 'rank', instructions: 'x' } } }],
    ['an llm field', { system_file: 'p.md' }],
    ['a numeric state', { state: 3 }],
    ['an empty state', { state: '' }],
  ])('rejects %s', (_name, over) => {
    const r = DecideAction.safeParse({ ...action, ...over });
    expect(r.success).toBe(false);
  });

  it('points the static-policy issue at the question', () => {
    const r = DecideAction.safeParse({
      ...action,
      questions: { u: { type: 'noul', instructions: 'Is ${event.x} urgent?' } },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({
      path: ['questions', 'u', 'instructions'],
      message: expect.stringMatching(/static policy/) as string,
    });
  });
});

describe('runDecide', () => {
  it('applies defaults, renders the state per leaf, caps the budget and returns the answers', async () => {
    const llm = fakeLlmPort({
      decideDefaults: { provider: 'router' },
      respondDecide: () => result(),
    });
    const ctx = testContext({
      llm,
      task: { name: 'triage', budget: { max_usd: 0.5 } } as never,
      scope: { event: { payload: { subject: 'Hello', body: 'Add the event.' } } },
    });
    await expect(runDecide({ ...action, budget: { max_usd: 0.001 } }, ctx)).resolves.toEqual(
      answers,
    );
    expect(llm.decides).toHaveLength(1);
    expect(llm.decides[0]?.req).toEqual({
      provider: 'router',
      model: 'typesafe/jev-1.13',
      state: { subject: 'Hello', body: 'Add the event.' },
      questions,
      maxUsd: 0.001,
    });
    expect(llm.decides[0]?.ctx).toMatchObject({ task: 'triage', run: { id: 'run_test' } });
  });

  it('injects a whole-string state template as the raw value and lets the action override defaults', async () => {
    const llm = fakeLlmPort({
      decideDefaults: { provider: 'a', model: 'm' },
      respondDecide: () => result(),
    });
    const payload = { subject: 'S', tags: ['x', 'y'] };
    const ctx = testContext({ llm, scope: { event: { payload } } });
    await runDecide(
      { ...action, provider: 'b', model: '~typesafe/jev-latest', state: '${event.payload}' },
      ctx,
    );
    expect(llm.decides[0]?.req).toMatchObject({
      provider: 'b',
      model: '~typesafe/jev-latest',
      state: payload,
      maxUsd: undefined,
    });
    await runDecide({ ...action, state: 'Subject: ${event.payload.subject}' }, ctx);
    expect(llm.decides[1]?.req.state).toBe('Subject: S');
  });

  it('keeps only the configured questions in the result', async () => {
    const llm = fakeLlmPort({
      decideDefaults: { provider: 'r' },
      respondDecide: () => result({ answers: { ...answers, extra: { type: 'noul', noul: 0.1 } } }),
    });
    await expect(
      runDecide(action, testContext({ llm, scope: { event: { payload: {} } } })),
    ).resolves.toEqual(answers);
  });

  it('fails non-retryably without a port or provider, or when the state renders to nothing', async () => {
    await expect(runDecide(action, testContext())).rejects.toThrow(
      new NonRetryableError('no llm service is configured'),
    );
    const noProvider = fakeLlmPort();
    await expect(
      runDecide(action, testContext({ llm: noProvider, scope: { event: { payload: {} } } })),
    ).rejects.toThrow(/no provider: set action.provider or defaults.decide.provider/);
    const llm = fakeLlmPort({ decideDefaults: { provider: 'r' }, respondDecide: () => result() });
    const ctx = testContext({ llm, scope: { event: { payload: {} } } });
    await expect(runDecide({ ...action, state: '${event.payload.missing}' }, ctx)).rejects.toThrow(
      /state rendered to null/,
    );
    await expect(runDecide({ ...action, state: '${event.payload}' }, ctx)).resolves.toBeDefined();
    expect(llm.decides).toHaveLength(1);
  });

  it.each([
    [
      'a missing answer',
      { kind: answers.kind, urgent: answers.urgent },
      /no answer for question "anger"/,
    ],
    [
      'a wrong type',
      { ...answers, urgent: { type: 'choice', choice: 'x' } },
      /is a noul but was answered as choice/,
    ],
    [
      'a choice outside the criteria',
      { ...answers, kind: { type: 'choice', choice: 'spam' } },
      /"spam" is not one of update, ignore/,
    ],
    ['a score out of range', { ...answers, anger: { type: 'score', score: 2.5 } }, /outside 0..2/],
    [
      'a non-numeric noul',
      { ...answers, urgent: { type: 'noul', noul: 'yes' } },
      /noul is not a number/,
    ],
    [
      'a noul above 1',
      { ...answers, urgent: { type: 'noul', noul: 1.5 } },
      /question "urgent": noul 1.5 is outside 0..1/,
    ],
    [
      'a negative noul',
      { ...answers, urgent: { type: 'noul', noul: -0.1 } },
      /question "urgent": noul -0.1 is outside 0..1/,
    ],
    [
      'a choice without a confidence',
      { ...answers, kind: { ...answers.kind, confidence: undefined } },
      /question "kind": confidence undefined is not a number in 0..1/,
    ],
    [
      'a non-numeric choice confidence',
      { ...answers, kind: { ...answers.kind, confidence: 'high' } },
      /question "kind": confidence high is not a number in 0..1/,
    ],
    [
      'a choice confidence above 1',
      { ...answers, kind: { ...answers.kind, confidence: 1.2 } },
      /question "kind": confidence 1.2 is not a number in 0..1/,
    ],
    [
      'a score without a confidence',
      { ...answers, anger: { ...answers.anger, confidence: undefined } },
      /question "anger": confidence undefined is not a number in 0..1/,
    ],
    [
      'a negative score confidence',
      { ...answers, anger: { ...answers.anger, confidence: -1 } },
      /question "anger": confidence -1 is not a number in 0..1/,
    ],
    [
      'a choice without probabilities',
      { ...answers, kind: { ...answers.kind, probabilities: undefined } },
      /question "kind": probabilities is not a map of criteria to numbers/,
    ],
    [
      'choice probabilities as an array',
      { ...answers, kind: { ...answers.kind, probabilities: [0.9, 0.1] } },
      /question "kind": probabilities is not a map of criteria to numbers/,
    ],
    [
      'a choice probability for an unknown label',
      { ...answers, kind: { ...answers.kind, probabilities: { update: 0.9, spam: 0.1 } } },
      /question "kind": probabilities has "spam", which is not one of update, ignore/,
    ],
    [
      'a choice probability above 1',
      { ...answers, kind: { ...answers.kind, probabilities: { update: 1.4 } } },
      /question "kind": probability 1.4 for "update" is outside 0..1/,
    ],
    [
      'a non-numeric choice probability',
      { ...answers, kind: { ...answers.kind, probabilities: { update: '0.9' } } },
      /question "kind": probability 0.9 for "update" is outside 0..1/,
    ],
    [
      'a score without probabilities',
      { ...answers, anger: { ...answers.anger, probabilities: undefined } },
      /question "anger": probabilities is not a map of criteria to numbers/,
    ],
    [
      'a score probability for a level that does not exist',
      { ...answers, anger: { ...answers.anger, probabilities: { '1': 0.9, '3': 0.1 } } },
      /question "anger": probabilities has "3", which is not one of 0, 1, 2/,
    ],
    [
      'a score probability keyed by label',
      { ...answers, anger: { ...answers.anger, probabilities: { Calm: 1 } } },
      /question "anger": probabilities has "Calm", which is not one of 0, 1, 2/,
    ],
  ])('fails retryably on %s', async (_name, bad, message) => {
    const llm = fakeLlmPort({
      decideDefaults: { provider: 'r' },
      respondDecide: () => result({ answers: bad as Record<string, DecideAnswer> }),
    });
    const p = runDecide(action, testContext({ llm, scope: { event: { payload: {} } } }));
    await expect(p).rejects.toThrow(message);
    await p.catch((err: unknown) => {
      expect(isRetryable(err)).toBe(true);
    });
  });
});
