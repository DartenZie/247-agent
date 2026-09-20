import { describe, expect, it } from 'vitest';

import { isRetryable, NonRetryableError } from '../actions/types.js';
import { createOpenRouterProvider } from './openrouter.js';
import { recordingFetch, type CapturedRequest, type RecordingFetch } from './testing.js';
import type { LlmRequest, LlmResponse, ResolvedProvider } from './types.js';

const KEY = 'sk-or-v1-very-secret';
const provider: ResolvedProvider = {
  name: 'openrouter',
  type: 'openrouter',
  apiKey: KEY,
  headers: { 'HTTP-Referer': 'https://example.com', 'X-Title': '247-agent' },
};
const SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: false,
};

function choice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    finish_reason: 'stop',
    logprobs: null,
    message: { role: 'assistant', content: '{"kind":"general_change"}', refusal: null },
    ...over,
  };
}

function completion(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gen-01',
    object: 'chat.completion',
    created: 1,
    model: 'openai/gpt-5-mini',
    choices: [choice()],
    usage: {
      prompt_tokens: 920,
      completion_tokens: 15,
      total_tokens: 935,
      prompt_tokens_details: { cached_tokens: 800 },
      cost: 0.00042,
      is_byok: false,
    },
    ...over,
  };
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'openai/gpt-5-mini',
    input: 'Subject: Spring event',
    maxTokens: 256,
    signal: new AbortController().signal,
    ...over,
  };
}

async function call(
  reply: unknown,
  over: Partial<LlmRequest> = {},
  status = 200,
  prov: ResolvedProvider = provider,
): Promise<{ res: LlmResponse; calls: CapturedRequest[] }> {
  const t = recordingFetch(reply, status);
  const res = await createOpenRouterProvider({ fetch: t.fetch })(prov).complete(request(over));
  return { res, calls: t.calls };
}

async function failure(
  reply: unknown,
  status = 200,
  over: Partial<LlmRequest> = {},
): Promise<{ err: unknown; calls: CapturedRequest[] }> {
  const t = recordingFetch(reply, status);
  try {
    await createOpenRouterProvider({ fetch: t.fetch })(provider).complete(request(over));
  } catch (err) {
    return { err, calls: t.calls };
  }
  throw new Error('expected a failure');
}

describe('openrouter adapter: request shape', () => {
  it('sends a system and a user message, max_tokens, a strict response_format and reasoning.effort', async () => {
    const { calls } = await call(completion(), {
      system: 'You classify emails.',
      outputSchema: SCHEMA,
      effort: 'low',
      maxTokens: 512,
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(c?.body).toEqual({
      model: 'openai/gpt-5-mini',
      messages: [
        { role: 'system', content: 'You classify emails.' },
        { role: 'user', content: 'Subject: Spring event' },
      ],
      max_tokens: 512,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', schema: SCHEMA, strict: true },
      },
      reasoning: { effort: 'low' },
    });
    expect(c?.body).not.toHaveProperty('usage'); // `usage.include` is a deprecated no-op
  });

  it('without a system prompt, schema or effort sends the bare request and returns the text', async () => {
    const { res, calls } = await call(
      completion({ choices: [choice({ message: { role: 'assistant', content: 'Hello' } })] }),
    );
    expect(calls[0]?.body).toEqual({
      model: 'openai/gpt-5-mini',
      messages: [{ role: 'user', content: 'Subject: Spring event' }],
      max_tokens: 256,
    });
    expect(res.output).toBeNull();
    expect(res.text).toBe('Hello');
  });

  it('puts the key in the Authorization header only and sends the attribution headers', async () => {
    const { calls } = await call(completion());
    const [c] = calls;
    expect(c?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(c?.headers.get('http-referer')).toBe('https://example.com');
    expect(c?.headers.get('x-title')).toBe('247-agent');
    expect(c?.raw).not.toContain(KEY);
    expect(c?.url).not.toContain(KEY);
  });

  it('honours base_url', async () => {
    const { calls } = await call(completion(), {}, 200, {
      ...provider,
      baseUrl: 'https://proxy.example.com/or/v1',
    });
    expect(calls[0]?.url).toBe('https://proxy.example.com/or/v1/chat/completions');
  });
});

describe('openrouter adapter: response mapping', () => {
  it('returns the parsed object, the reported cost and input without the cached tokens', async () => {
    const { res } = await call(completion(), { outputSchema: SCHEMA });
    expect(res).toEqual({
      output: { kind: 'general_change' },
      usage: { input: 120, output: 15, cacheRead: 800, cacheWrite: 0, reportedUsd: 0.00042 },
      stopReason: 'end',
    });
  });

  it('leaves reportedUsd unset when the response carries no cost', async () => {
    const { res } = await call(
      completion({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
    );
    expect(res.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
    expect(res.usage).not.toHaveProperty('reportedUsd');
  });

  it('counts cache writes separately', async () => {
    const { res } = await call(
      completion({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 3,
          total_tokens: 1003,
          prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 850 },
          cost: 0.001,
        },
      }),
    );
    expect(res.usage).toEqual({
      input: 50,
      output: 3,
      cacheRead: 100,
      cacheWrite: 850,
      reportedUsd: 0.001,
    });
  });

  it.each([
    ['stop', 'end'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['tool_calls', 'other'],
    ['error', 'other'],
    [null, 'other'],
  ])('maps finish_reason %s to %s', async (from, to) => {
    const { res } = await call(completion({ choices: [choice({ finish_reason: from })] }));
    expect(res.stopReason).toBe(to);
  });

  it('a refusal message is a refusal with a null output', async () => {
    const { res } = await call(
      completion({
        choices: [choice({ message: { role: 'assistant', content: null, refusal: 'I cannot.' } })],
      }),
      { outputSchema: SCHEMA },
    );
    expect(res).toMatchObject({ output: null, stopReason: 'refusal' });
  });

  it('a 200 with an error body and no choices fails retryably with the message', async () => {
    const { err } = await failure({
      error: { message: 'Provider returned error', code: 502, metadata: {} },
      choices: [],
    });
    expect((err as Error).message).toBe('openrouter: Provider returned error');
    expect(isRetryable(err)).toBe(true);
  });

  it('fails retryably when a completed response has no structured output', async () => {
    const { err } = await failure(
      completion({ choices: [choice({ message: { role: 'assistant', content: '' } })] }),
      200,
      { outputSchema: SCHEMA },
    );
    expect((err as Error).message).toMatch(/without a structured output/);
    expect(isRetryable(err)).toBe(true);
  });

  it('fails retryably when the structured output is not JSON', async () => {
    const { err } = await failure(
      completion({ choices: [choice({ message: { role: 'assistant', content: '{not json' } })] }),
      200,
      { outputSchema: SCHEMA },
    );
    expect((err as Error).message).toMatch(/openrouter: failed to parse the structured output/);
    expect(isRetryable(err)).toBe(true);
  });
});

describe('openrouter adapter: errors', () => {
  function apiError(code: number, msg: string): Record<string, unknown> {
    return { error: { code, message: msg, metadata: {} } };
  }

  it.each([
    [401, 'No auth credentials found'],
    [400, 'Invalid schema'],
    [403, 'Moderation flagged'],
    [404, 'No endpoints found for nope/model'],
  ])('%s is not retryable and drops the numeric code', async (status, text) => {
    const { err } = await failure(apiError(status, text), status);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toBe(`openrouter: ${String(status)} ${text}`);
    expect((err as Error).message).not.toContain(KEY);
    expect(isRetryable(err)).toBe(false);
  });

  it.each([
    [429, 'Rate limited'],
    [500, 'Internal'],
    [502, 'Provider is down'],
    [503, 'No available provider'],
  ])('%s is retryable and never retried by the SDK itself', async (status, text) => {
    const { err, calls } = await failure(apiError(status, text), status);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toBe(`openrouter: ${String(status)} ${text}`);
    expect((err as Error).message).not.toContain(KEY);
    expect(isRetryable(err)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a transport failure is retryable', async () => {
    const { err } = await failure(new TypeError('fetch failed'));
    expect((err as Error).message).toMatch(/connection/i);
    expect(isRetryable(err)).toBe(true);
  });

  it('an already-aborted signal rejects without touching the network', async () => {
    const t = recordingFetch(completion());
    const ac = new AbortController();
    ac.abort(new Error('run timed out'));
    await expect(
      createOpenRouterProvider({ fetch: t.fetch })(provider).complete(
        request({ signal: ac.signal }),
      ),
    ).rejects.toThrow(/abort/i);
    expect(t.calls).toHaveLength(0);
  });

  it('aborting mid-flight cancels the request', async () => {
    const ac = new AbortController();
    let sawAbort = false;
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch: RecordingFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        started();
      });
    const p = createOpenRouterProvider({ fetch })(provider).complete(
      request({ signal: ac.signal }),
    );
    await entered;
    ac.abort(new Error('run timed out'));
    await expect(p).rejects.toThrow(/abort/i);
    expect(sawAbort).toBe(true);
  });
});
