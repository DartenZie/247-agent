import { describe, expect, it } from 'vitest';

import { isRetryable, NonRetryableError } from '../actions/types.js';
import { createOpenAiProvider } from './openai.js';
import { recordingFetch, type CapturedRequest, type RecordingFetch } from './testing.js';
import type { LlmRequest, LlmResponse, ResolvedProvider } from './types.js';

const KEY = 'sk-proj-very-secret';
const provider: ResolvedProvider = {
  name: 'openai',
  type: 'openai',
  apiKey: KEY,
  headers: { 'X-Title': '247-agent' },
};
const SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: false,
};

function textItem(text: string): Record<string, unknown> {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function response(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_01',
    object: 'response',
    created_at: 1,
    model: 'gpt-5-mini',
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    output: [textItem('{"kind":"general_change"}')],
    parallel_tool_calls: false,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    usage: {
      input_tokens: 920,
      input_tokens_details: { cached_tokens: 800, cache_write_tokens: 20 },
      output_tokens: 15,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 935,
    },
    ...over,
  };
}

function apiError(code: string, type: string, msg: string): Record<string, unknown> {
  return { error: { message: msg, type, param: null, code } };
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gpt-5-mini',
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
  const res = await createOpenAiProvider({ fetch: t.fetch })(prov).complete(request(over));
  return { res, calls: t.calls };
}

async function failure(
  reply: unknown,
  status = 200,
  over: Partial<LlmRequest> = {},
): Promise<{ err: unknown; calls: CapturedRequest[] }> {
  const t = recordingFetch(reply, status);
  try {
    await createOpenAiProvider({ fetch: t.fetch })(provider).complete(request(over));
  } catch (err) {
    return { err, calls: t.calls };
  }
  throw new Error('expected a failure');
}

describe('openai adapter: request shape', () => {
  it('sends instructions, the input, a strict schema and effort on a reasoning model, and never stores', async () => {
    const { calls } = await call(response(), {
      system: 'You classify emails.',
      outputSchema: SCHEMA,
      effort: 'low',
      maxTokens: 512,
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe('https://api.openai.com/v1/responses');
    expect(c?.body).toEqual({
      model: 'gpt-5-mini',
      input: 'Subject: Spring event',
      max_output_tokens: 512,
      store: false,
      instructions: 'You classify emails.',
      reasoning: { effort: 'low' },
      text: {
        format: { type: 'json_schema', name: 'output', schema: SCHEMA, strict: true },
      },
    });
  });

  it('drops effort on a model without the reasoning parameter', async () => {
    const { calls } = await call(response(), { model: 'gpt-4.1-mini', effort: 'high' });
    expect(calls[0]?.body).toEqual({
      model: 'gpt-4.1-mini',
      input: 'Subject: Spring event',
      max_output_tokens: 256,
      store: false,
    });
  });

  it('without a schema returns the joined text of every output_text part', async () => {
    const { res, calls } = await call(
      response({
        output: [
          { id: 'rs_01', type: 'reasoning', summary: [] },
          textItem('Hello'),
          textItem(', world'),
        ],
      }),
    );
    expect(calls[0]?.body).not.toHaveProperty('text');
    expect(calls[0]?.body).not.toHaveProperty('instructions');
    expect(res.output).toBeNull();
    expect(res.text).toBe('Hello, world');
  });

  it('puts the key in the Authorization header only and honours base_url and extra headers', async () => {
    const { calls } = await call(response(), {}, 200, {
      ...provider,
      baseUrl: 'https://proxy.example.com/openai/v1',
    });
    const [c] = calls;
    expect(c?.url).toBe('https://proxy.example.com/openai/v1/responses');
    expect(c?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(c?.headers.get('x-api-key')).toBeNull();
    expect(c?.headers.get('x-title')).toBe('247-agent');
    expect(c?.raw).not.toContain(KEY);
    expect(c?.url).not.toContain(KEY);
  });
});

describe('openai adapter: response mapping', () => {
  it('returns the parsed object and moves cached and cache-written tokens out of input', async () => {
    const { res } = await call(response(), { outputSchema: SCHEMA });
    expect(res).toEqual({
      output: { kind: 'general_change' },
      usage: { input: 100, output: 15, cacheRead: 800, cacheWrite: 20 },
      stopReason: 'end',
    });
  });

  it('treats a missing details block as no cache traffic', async () => {
    const { res } = await call(
      response({ usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }),
    );
    expect(res.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
    expect(res.usage).not.toHaveProperty('reportedUsd');
  });

  it.each([
    ['completed', null, 'end'],
    ['incomplete', { reason: 'max_output_tokens' }, 'max_tokens'],
    ['incomplete', { reason: 'content_filter' }, 'refusal'],
    ['incomplete', { reason: 'max_messages' }, 'other'],
    ['in_progress', null, 'other'],
  ])('maps status %s %j to %s', async (status, incomplete, to) => {
    const { res } = await call(response({ status, incomplete_details: incomplete }));
    expect(res.stopReason).toBe(to);
  });

  it('a refusal part is a refusal with a null output', async () => {
    const { res } = await call(
      response({
        output: [
          {
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
          },
        ],
      }),
      { outputSchema: SCHEMA },
    );
    expect(res).toMatchObject({ output: null, stopReason: 'refusal' });
  });

  it('a truncated output is reported as max_tokens, not as a parse failure', async () => {
    const { res } = await call(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [textItem('{"kind":"gen')],
      }),
      { outputSchema: SCHEMA },
    );
    expect(res).toMatchObject({ output: null, stopReason: 'max_tokens' });
  });

  it('a failed response surfaces its error retryably', async () => {
    const { err } = await failure(
      response({ status: 'failed', error: { code: 'server_error', message: 'try later' } }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('openai: server_error: try later');
    expect(isRetryable(err)).toBe(true);
  });

  it('fails retryably when a completed response has no structured output', async () => {
    const { err } = await failure(response({ output: [] }), 200, { outputSchema: SCHEMA });
    expect((err as Error).message).toMatch(/without a structured output/);
    expect(isRetryable(err)).toBe(true);
  });

  it('fails retryably when the structured output is not JSON', async () => {
    const { err } = await failure(response({ output: [textItem('{not json')] }), 200, {
      outputSchema: SCHEMA,
    });
    expect((err as Error).message).toMatch(/openai: failed to parse the structured output/);
    expect(isRetryable(err)).toBe(true);
  });
});

describe('openai adapter: errors', () => {
  it.each([
    [401, 'invalid_api_key', 'invalid_request_error', 'Incorrect API key provided'],
    [400, 'invalid_json_schema', 'invalid_request_error', 'additionalProperties is required'],
    [403, 'unsupported_country', 'invalid_request_error', 'not available'],
    [404, 'model_not_found', 'invalid_request_error', 'The model gpt-nope does not exist'],
    [422, 'unprocessable', 'invalid_request_error', 'unprocessable'],
  ])('%s is not retryable', async (status, code, type, text) => {
    const { err } = await failure(apiError(code, type, text), status);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toBe(`openai: ${String(status)} ${code}: ${text}`);
    expect((err as Error).message).not.toContain(KEY);
    expect(isRetryable(err)).toBe(false);
  });

  it('falls back to the error type when the body has no code', async () => {
    const { err } = await failure(
      { error: { message: 'bad', type: 'invalid_request_error' } },
      400,
    );
    expect((err as Error).message).toBe('openai: 400 invalid_request_error: bad');
  });

  it.each([
    [429, 'rate_limit_exceeded', 'slow down'],
    [500, 'server_error', 'internal'],
    [503, 'server_error', 'overloaded'],
  ])('%s is retryable and never retried by the SDK itself', async (status, code, text) => {
    const { err, calls } = await failure(apiError(code, 'server_error', text), status);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toBe(`openai: ${String(status)} ${code}: ${text}`);
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
    const t = recordingFetch(response());
    const ac = new AbortController();
    ac.abort(new Error('run timed out'));
    await expect(
      createOpenAiProvider({ fetch: t.fetch })(provider).complete(request({ signal: ac.signal })),
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
    const p = createOpenAiProvider({ fetch })(provider).complete(request({ signal: ac.signal }));
    await entered;
    ac.abort(new Error('run timed out'));
    await expect(p).rejects.toThrow(/abort/i);
    expect(sawAbort).toBe(true);
  });
});
