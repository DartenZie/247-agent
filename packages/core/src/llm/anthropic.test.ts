import { describe, expect, it } from 'vitest';

import { isRetryable, NonRetryableError } from '../actions/types.js';
import { createAnthropicProvider, type FetchLike } from './anthropic.js';
import type { LlmRequest, LlmResponse, ResolvedProvider } from './types.js';

const KEY = 'sk-ant-api03-very-secret';
const provider: ResolvedProvider = {
  name: 'anthropic',
  type: 'anthropic',
  apiKey: KEY,
  headers: { 'X-Title': '247-agent' },
};
const SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: false,
};

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  raw: string;
}

/** A transport that records the request and answers with `reply` (an object, or a thrower). */
function transport(reply: unknown, status = 200): { calls: Captured[]; fetch: FetchLike } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(raw) as Record<string, unknown>,
      raw,
    });
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch };
}

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: '{"kind":"general_change"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 15,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    },
    ...over,
  };
}

function apiError(type: string, msg: string): Record<string, unknown> {
  return { type: 'error', error: { type, message: msg } };
}

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-haiku-4-5',
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
): Promise<{ res: LlmResponse; calls: Captured[] }> {
  const t = transport(reply, status);
  const res = await createAnthropicProvider({ fetch: t.fetch })(prov).complete(request(over));
  return { res, calls: t.calls };
}

async function failure(reply: unknown, status: number): Promise<unknown> {
  const t = transport(reply, status);
  try {
    await createAnthropicProvider({ fetch: t.fetch })(provider).complete(request());
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

describe('anthropic adapter: request shape', () => {
  it('sends a cached system block, one user turn, the schema, thinking and effort on Sonnet/Opus 5', async () => {
    const { calls } = await call(message(), {
      model: 'claude-sonnet-5',
      system: 'You classify emails.',
      outputSchema: SCHEMA,
      effort: 'low',
      maxTokens: 512,
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c?.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      system: [
        { type: 'text', text: 'You classify emails.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'Subject: Spring event' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(c?.raw).not.toContain('parse'); // the client-side parser never reaches the wire
    expect(c?.raw).not.toContain('budget_tokens');
  });

  it('omits thinking and effort on Haiku 4.5 even when effort is requested', async () => {
    const { calls } = await call(message(), { outputSchema: SCHEMA, effort: 'high' });
    expect(calls[0]?.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Subject: Spring event' }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
  });

  it('without a schema and system prompt sends the bare request and returns the joined text', async () => {
    const { res, calls } = await call(
      message({
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ', world' },
        ],
      }),
    );
    expect(calls[0]?.body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Subject: Spring event' }],
    });
    expect(res.output).toBeNull();
    expect(res.text).toBe('Hello, world');
  });

  it('sends effort without a schema on Opus 5', async () => {
    const { calls } = await call(message(), { model: 'claude-opus-5', effort: 'medium' });
    expect(calls[0]?.body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    expect(calls[0]?.body.output_config).not.toHaveProperty('format');
  });

  it('puts the key in x-api-key only and honours base_url and extra headers', async () => {
    const { calls } = await call(message(), {}, 200, {
      ...provider,
      baseUrl: 'https://proxy.example.com/anthropic',
    });
    const [c] = calls;
    expect(c?.url).toBe('https://proxy.example.com/anthropic/v1/messages');
    expect(c?.headers.get('x-api-key')).toBe(KEY);
    expect(c?.headers.get('authorization')).toBeNull();
    expect(c?.headers.get('x-title')).toBe('247-agent');
    expect(c?.raw).not.toContain(KEY);
    expect(c?.url).not.toContain(KEY);
  });
});

describe('anthropic adapter: response mapping', () => {
  it('returns the parsed object and maps usage 1:1', async () => {
    const { res } = await call(message(), { outputSchema: SCHEMA });
    expect(res).toEqual({
      output: { kind: 'general_change' },
      usage: { input: 120, output: 15, cacheRead: 800, cacheWrite: 40 },
      stopReason: 'end',
    });
  });

  it('treats null cache counters as zero', async () => {
    const { res } = await call(
      message({
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );
    expect(res.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  });

  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['tool_use', 'other'],
    ['model_context_window_exceeded', 'other'],
  ])('maps stop_reason %s to %s', async (from, to) => {
    const { res } = await call(message({ stop_reason: from }));
    expect(res.stopReason).toBe(to);
  });

  it('returns output null on a refusal with no content so the runner can report it', async () => {
    const { res } = await call(message({ stop_reason: 'refusal', content: [] }), {
      outputSchema: SCHEMA,
    });
    expect(res).toMatchObject({ output: null, stopReason: 'refusal' });
  });

  it('fails retryably when a completed response has no structured output', async () => {
    const t = transport(message({ content: [] }));
    const p = createAnthropicProvider({ fetch: t.fetch })(provider).complete(
      request({ outputSchema: SCHEMA }),
    );
    await expect(p).rejects.toThrow(/without a structured output/);
    await p.catch((err: unknown) => {
      expect(isRetryable(err)).toBe(true);
    });
  });

  it('fails retryably when the structured output is not JSON', async () => {
    const err = await (async () => {
      const t = transport(message({ content: [{ type: 'text', text: '{not json' }] }));
      try {
        await createAnthropicProvider({ fetch: t.fetch })(provider).complete(
          request({ outputSchema: SCHEMA }),
        );
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Failed to parse structured output/);
    expect(isRetryable(err)).toBe(true);
  });
});

describe('anthropic adapter: errors', () => {
  it.each([
    [401, 'authentication_error', 'invalid x-api-key'],
    [400, 'invalid_request_error', 'max_tokens: must be positive'],
    [403, 'permission_error', 'not allowed'],
    [404, 'not_found_error', 'model: claude-nope'],
    [422, 'invalid_request_error', 'unprocessable'],
  ])('%s is not retryable', async (status, type, text) => {
    const err = await failure(apiError(type, text), status);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toBe(`anthropic: ${String(status)} ${type}: ${text}`);
    expect((err as Error).message).not.toContain(KEY);
    expect(isRetryable(err)).toBe(false);
  });

  it.each([
    [429, 'rate_limit_error', 'slow down'],
    [500, 'api_error', 'internal'],
    [529, 'overloaded_error', 'overloaded'],
  ])('%s is retryable and never retried by the SDK itself', async (status, type, text) => {
    const t = transport(apiError(type, text), status);
    const p = createAnthropicProvider({ fetch: t.fetch })(provider).complete(request());
    await expect(p).rejects.toThrow(text);
    await p.catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(NonRetryableError);
      expect(isRetryable(err)).toBe(true);
      expect((err as Error).message).not.toContain(KEY);
    });
    expect(t.calls).toHaveLength(1);
  });

  it('a transport failure is retryable', async () => {
    const t = transport(new TypeError('fetch failed'));
    const p = createAnthropicProvider({ fetch: t.fetch })(provider).complete(request());
    await expect(p).rejects.toThrow(/connection/i);
    await p.catch((err: unknown) => {
      expect(isRetryable(err)).toBe(true);
    });
  });

  it('an already-aborted signal rejects without touching the network', async () => {
    const t = transport(message());
    const ac = new AbortController();
    ac.abort(new Error('run timed out'));
    await expect(
      createAnthropicProvider({ fetch: t.fetch })(provider).complete(
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
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        started();
      });
    const p = createAnthropicProvider({ fetch })(provider).complete(request({ signal: ac.signal }));
    await entered;
    ac.abort(new Error('run timed out'));
    await expect(p).rejects.toThrow(/abort/i);
    expect(sawAbort).toBe(true);
  });
});

/** A Message Batches API: POST creates `msgbatch_01`, GET reports `status`, the results URL serves `results` as JSONL. */
function batchApi(status: 'in_progress' | 'ended', results: unknown[] = []) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const batch = {
    id: 'msgbatch_01',
    type: 'message_batch',
    processing_status: status,
    request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    created_at: '2026-09-30T10:00:00Z',
    expires_at: '2026-10-01T10:00:00Z',
    ended_at: status === 'ended' ? '2026-09-30T10:05:00Z' : null,
    archived_at: null,
    cancel_initiated_at: null,
    results_url:
      status === 'ended'
        ? 'https://api.anthropic.com/v1/messages/batches/msgbatch_01/results'
        : null,
  };
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: raw === '' ? null : (JSON.parse(raw) as Record<string, unknown>),
    });
    if (url.endsWith('/results')) {
      return Promise.resolve(
        new Response(results.map((r) => JSON.stringify(r)).join('\n'), {
          headers: { 'content-type': 'application/binary' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(batch), { headers: { 'content-type': 'application/json' } }),
    );
  };
  return { calls, fetch };
}

describe('anthropic adapter: message batches', () => {
  const poll = (fetch: FetchLike, structured = true) => {
    const adapter = createAnthropicProvider({ fetch })(provider);
    if (adapter.pollBatch === undefined) {
      throw new Error('no pollBatch');
    }
    return adapter.pollBatch({
      batchId: 'msgbatch_01',
      customId: 'run_1',
      structured,
      signal: new AbortController().signal,
    });
  };

  it('submits the same request as one batch entry keyed by the run id', async () => {
    const api = batchApi('in_progress');
    const adapter = createAnthropicProvider({ fetch: api.fetch })(provider);
    const res = await adapter.submitBatch?.({
      ...request({ model: 'claude-sonnet-5', system: 'You classify.', effort: 'low' }),
      outputSchema: SCHEMA,
      customId: 'run_1',
    });
    expect(res).toEqual({ batchId: 'msgbatch_01' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages/batches');
    expect(api.calls[0]?.body).toEqual({
      requests: [
        {
          custom_id: 'run_1',
          params: {
            model: 'claude-sonnet-5',
            max_tokens: 256,
            messages: [{ role: 'user', content: 'Subject: Spring event' }],
            system: [{ type: 'text', text: 'You classify.', cache_control: { type: 'ephemeral' } }],
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
          },
        },
      ],
    });
  });

  it('sends no output_config on Haiku without a schema and refuses an unsafe custom_id', async () => {
    const api = batchApi('in_progress');
    const adapter = createAnthropicProvider({ fetch: api.fetch })(provider);
    if (adapter.submitBatch === undefined) {
      throw new Error('no submitBatch');
    }
    await expect(
      adapter.submitBatch({ ...request({ effort: 'high' }), customId: 'run_2' }),
    ).resolves.toEqual({ batchId: 'msgbatch_01' });
    expect(api.calls[0]?.body).toEqual({
      requests: [
        {
          custom_id: 'run_2',
          params: {
            model: 'claude-haiku-4-5',
            max_tokens: 256,
            messages: [{ role: 'user', content: 'Subject: Spring event' }],
          },
        },
      ],
    });
    await expect(
      adapter.submitBatch({ ...request(), customId: "x' || true" }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(api.calls).toHaveLength(1);
  });

  it('reports a batch in progress without fetching results', async () => {
    const api = batchApi('in_progress');
    await expect(poll(api.fetch)).resolves.toEqual({ status: 'in_progress' });
    expect(api.calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/messages/batches/msgbatch_01',
    ]);
  });

  it('parses a succeeded structured result and maps usage and stop reason', async () => {
    const api = batchApi('ended', [
      { custom_id: 'other', result: { type: 'expired' } },
      { custom_id: 'run_1', result: { type: 'succeeded', message: message() } },
    ]);
    await expect(poll(api.fetch)).resolves.toEqual({
      status: 'succeeded',
      response: {
        output: { kind: 'general_change' },
        usage: { input: 120, output: 15, cacheRead: 800, cacheWrite: 40 },
        stopReason: 'end',
      },
    });
  });

  it('returns the text without a schema and no output on truncation', async () => {
    const plain = batchApi('ended', [
      {
        custom_id: 'run_1',
        result: {
          type: 'succeeded',
          message: message({ content: [{ type: 'text', text: 'hello' }] }),
        },
      },
    ]);
    await expect(poll(plain.fetch, false)).resolves.toMatchObject({
      status: 'succeeded',
      response: { output: null, text: 'hello', stopReason: 'end' },
    });
    const cut = batchApi('ended', [
      {
        custom_id: 'run_1',
        result: { type: 'succeeded', message: message({ stop_reason: 'max_tokens' }) },
      },
    ]);
    await expect(poll(cut.fetch)).resolves.toMatchObject({
      status: 'succeeded',
      response: { output: null, stopReason: 'max_tokens' },
    });
  });

  it('flags a billed structured result that is not JSON', async () => {
    const api = batchApi('ended', [
      {
        custom_id: 'run_1',
        result: {
          type: 'succeeded',
          message: message({ content: [{ type: 'text', text: 'not json' }] }),
        },
      },
    ]);
    await expect(poll(api.fetch)).resolves.toMatchObject({
      status: 'succeeded',
      error: expect.stringMatching(/without a structured output/) as unknown,
    });
  });

  it('maps errored, expired and canceled results; only an invalid request is final', async () => {
    const outcome = async (result: unknown) =>
      poll(batchApi('ended', [{ custom_id: 'run_1', result }]).fetch);
    await expect(
      outcome({
        type: 'errored',
        error: { type: 'error', error: apiError('invalid_request_error', 'bad').error },
      }),
    ).resolves.toEqual({
      status: 'errored',
      error: 'anthropic: invalid_request_error: bad',
      retryable: false,
    });
    await expect(
      outcome({
        type: 'errored',
        error: { type: 'error', error: apiError('overloaded_error', 'busy').error },
      }),
    ).resolves.toMatchObject({ status: 'errored', retryable: true });
    await expect(outcome({ type: 'expired' })).resolves.toMatchObject({
      status: 'expired',
      retryable: true,
    });
    await expect(outcome({ type: 'canceled' })).resolves.toMatchObject({
      status: 'canceled',
      retryable: true,
    });
  });

  it('fails non-retryably when the ended batch has no result for the run', async () => {
    const err = await poll(batchApi('ended', []).fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(isRetryable(err)).toBe(false);
  });
});
