import { beforeEach, describe, expect, it } from 'vitest';

import { fakeLlmPort } from '../llm/testing.js';
import type { LlmCallResult } from '../llm/types.js';
import type { EventRecord, JsonValue } from '../store/types.js';
import { LlmAction, runLlm } from './llm.js';
import { testContext } from './testing.js';
import { isRetryable, NonRetryableError, type ResumeInfo, type WaitSpec } from './types.js';

const result = (over: Partial<LlmCallResult> = {}): LlmCallResult => ({
  output: { kind: 'general_change', summary: 's' },
  text: 'plain answer',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  stopReason: 'end',
  usd: 0.001,
  priced_by: 'table',
  ledgerId: 1,
  ...over,
});

const action = {
  kind: 'llm',
  system_file: 'prompts/classify.md',
  input: 'Subject: ${event.payload.subject}',
  output_schema: { type: 'object', properties: { kind: { type: 'string' } } },
};

describe('LlmAction schema', () => {
  it('accepts the documented shape and rejects two system prompts and templated system', () => {
    expect(LlmAction.safeParse({ ...action, provider: 'anthropic', effort: 'low' }).success).toBe(
      true,
    );
    expect(LlmAction.safeParse({ ...action, batch: true }).success).toBe(true);
    expect(LlmAction.safeParse({ ...action, system: 'x' }).success).toBe(false);
    expect(LlmAction.safeParse({ kind: 'llm', input: 'x', system: 'hi ${event.x}' }).success).toBe(
      false,
    );
    expect(
      LlmAction.safeParse({ kind: 'llm', input: 'x', output_schema: { type: 'array' } }).success,
    ).toBe(false);
  });
});

describe('runLlm', () => {
  it('applies defaults, reads the system file, renders the input and returns the structured output', async () => {
    const llm = fakeLlmPort({
      defaults: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        effort: 'medium',
      },
      systemFiles: { 'prompts/classify.md': 'You classify.' },
      respond: () => result(),
    });
    const ctx = testContext({
      llm,
      task: { name: 'classify', budget: { max_usd: 0.5 } } as never,
      scope: { event: { payload: { subject: 'Hello' } } },
    });
    await expect(runLlm({ ...action, budget: { max_usd: 0.2 } }, ctx)).resolves.toEqual({
      kind: 'general_change',
      summary: 's',
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.req).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      system: 'You classify.',
      input: 'Subject: Hello',
      outputSchema: action.output_schema,
      maxTokens: 512,
      effort: 'medium',
      maxUsd: 0.2,
    });
    expect(llm.calls[0]?.ctx).toMatchObject({ task: 'classify', run: { id: 'run_test' } });
  });

  it('returns {text} without a schema and lets the action override the defaults', async () => {
    const llm = fakeLlmPort({ defaults: { provider: 'a', model: 'm' }, respond: () => result() });
    const ctx = testContext({ llm, scope: {} });
    await expect(
      runLlm(
        { kind: 'llm', provider: 'b', model: 'n', input: 'hi', system: 'sys', max_tokens: 5 },
        ctx,
      ),
    ).resolves.toEqual({ text: 'plain answer' });
    expect(llm.calls[0]?.req).toMatchObject({
      provider: 'b',
      model: 'n',
      system: 'sys',
      maxTokens: 5,
      maxUsd: undefined,
    });
  });

  it('fails non-retryably without a port, provider or model, and on truncation or refusal', async () => {
    await expect(runLlm({ kind: 'llm', input: 'x' }, testContext())).rejects.toThrow(
      new NonRetryableError('no llm service is configured'),
    );
    const noProvider = fakeLlmPort({ defaults: { model: 'm' } });
    await expect(
      runLlm({ kind: 'llm', input: 'x' }, testContext({ llm: noProvider })),
    ).rejects.toThrow(/no provider/);
    const noModel = fakeLlmPort({ defaults: { provider: 'p' } });
    await expect(
      runLlm({ kind: 'llm', input: 'x' }, testContext({ llm: noModel })),
    ).rejects.toThrow(/no model/);
    const truncated = fakeLlmPort({
      defaults: { provider: 'p', model: 'm' },
      respond: () => result({ stopReason: 'max_tokens' }),
    });
    await expect(
      runLlm({ kind: 'llm', input: 'x' }, testContext({ llm: truncated })),
    ).rejects.toThrow(/truncated at max_tokens 1024/);
    const refused = fakeLlmPort({
      defaults: { provider: 'p', model: 'm' },
      respond: () => result({ stopReason: 'refusal' }),
    });
    await expect(
      runLlm({ kind: 'llm', input: 'x' }, testContext({ llm: refused })),
    ).rejects.toThrow(NonRetryableError);
  });
});

describe('runLlm with batch: true', () => {
  const batched = { kind: 'llm', input: 'x', batch: true, output_schema: { type: 'object' } };
  const SUSPENDED = new Error('suspended');
  const suspended: { spec: WaitSpec; resume: JsonValue }[] = [];
  const suspend = (spec: WaitSpec, resume: JsonValue): Promise<never> => {
    suspended.push({ spec, resume });
    return Promise.reject(SUSPENDED);
  };
  const ended = (payload: JsonValue, outcome: 'matched' | 'timeout' = 'matched'): ResumeInfo => ({
    resume: { batch_id: 'msgbatch_1', attempt: 1 },
    outcome,
    event: { payload } as EventRecord,
  });

  beforeEach(() => {
    suspended.length = 0;
  });

  it('submits the call and parks the run on llm.batch.ended for its batch', async () => {
    const llm = fakeLlmPort({ defaults: { provider: 'anthropic', model: 'claude-haiku-4-5' } });
    const ctx = testContext({
      llm,
      suspend,
      task: { name: 't', budget: { max_usd: 0.1 } } as never,
    });
    await expect(runLlm(batched, ctx)).rejects.toBe(SUSPENDED);
    expect(llm.calls).toEqual([]);
    expect(llm.batches[0]?.req).toMatchObject({ provider: 'anthropic', input: 'x', maxUsd: 0.1 });
    expect(suspended).toEqual([
      {
        spec: {
          type: 'llm.batch.ended',
          filter: "payload.batch_id == 'msgbatch_1'",
          timeoutMs: 25 * 3_600_000,
          on_timeout: 'fail',
        },
        resume: { batch_id: 'msgbatch_1', attempt: 1 },
      },
    ]);
  });

  it('returns the result when resumed with a succeeded batch', async () => {
    const llm = fakeLlmPort({
      defaults: { provider: 'anthropic', model: 'm' },
      batchResult: () => ({ status: 'succeeded', result: result() }),
    });
    const ctx = testContext({ llm, suspend, resume: ended({ status: 'succeeded' }) });
    await expect(runLlm(batched, ctx)).resolves.toEqual({ kind: 'general_change', summary: 's' });
    expect(llm.batchResults).toEqual([{ payload: { status: 'succeeded' }, maxUsd: undefined }]);
    expect(llm.batches).toEqual([]);
    const cut = fakeLlmPort({
      defaults: { provider: 'anthropic', model: 'm' },
      batchResult: () => ({ status: 'succeeded', result: result({ stopReason: 'max_tokens' }) }),
    });
    await expect(
      runLlm(batched, testContext({ llm: cut, suspend, resume: ended({}) })),
    ).rejects.toThrow(/truncated at max_tokens/);
  });

  it('fails the attempt that submitted a failed batch, and resubmits on the retry', async () => {
    const failed = (retryable: boolean) =>
      fakeLlmPort({
        defaults: { provider: 'anthropic', model: 'm' },
        batchResult: () => ({ status: 'expired', error: 'too slow', retryable }),
      });
    const retryable = runLlm(
      batched,
      testContext({ llm: failed(true), suspend, resume: ended({}) }),
    );
    await expect(retryable).rejects.toThrow('batch msgbatch_1 expired: too slow');
    await expect(retryable.catch((e: unknown) => isRetryable(e))).resolves.toBe(true);
    await expect(
      runLlm(batched, testContext({ llm: failed(false), suspend, resume: ended({}) })),
    ).rejects.toBeInstanceOf(NonRetryableError);

    const llm = failed(true);
    const retry = testContext({ llm, suspend, resume: ended({}) });
    const nextAttempt = { ...retry, run: { ...retry.run, attempt: 2 } };
    await expect(runLlm(batched, nextAttempt)).rejects.toBe(SUSPENDED);
    expect(llm.batches).toHaveLength(1);
    expect(suspended[0]?.resume).toEqual({ batch_id: 'msgbatch_1', attempt: 2 });
  });

  it('fails without retry when the wait timed out', async () => {
    const llm = fakeLlmPort({ defaults: { provider: 'anthropic', model: 'm' } });
    await expect(
      runLlm(batched, testContext({ llm, suspend, resume: ended(null, 'timeout') })),
    ).rejects.toThrow(new NonRetryableError('batch msgbatch_1 did not end within 25h'));
  });
});
