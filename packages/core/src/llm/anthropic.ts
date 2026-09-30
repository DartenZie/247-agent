import Anthropic from '@anthropic-ai/sdk';

import { NonRetryableError } from '../actions/types.js';
import type { JsonValue } from '../store/types.js';
import { supportsEffort } from './models.js';
import type {
  BatchPollRequest,
  BatchStatus,
  BatchSubmitRequest,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderFactory,
  StopReason,
} from './types.js';

type ClientOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>;
export type FetchLike = NonNullable<ClientOptions['fetch']>;

export interface AnthropicAdapterOptions {
  /** Replaces the HTTP transport (tests); never used by the daemon. */
  fetch?: FetchLike | undefined;
}

/**
 * The SDK refuses non-streaming requests whose `max_tokens` implies more than 10 minutes
 * unless a timeout is given explicitly. The run's own `timeout` aborts `signal` long
 * before this; it only keeps the SDK from second-guessing the caller.
 */
const HTTP_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The `anthropic` provider type (ARCHITECTURE §5.2, llm-action.md "Adapter notes"): one
 * `messages.parse()` (with a schema) or `messages.create()` (without) per call, the static
 * system prompt as a cached block, the input as the single user turn, adaptive thinking and
 * `output_config.effort` on Sonnet/Opus 5 only. No prefill, no SDK-level retries: whether to
 * try again is the task's `retry` policy, so 429/5xx/network errors surface as plain
 * `Error`s and 4xx client errors as `NonRetryableError`. `batch: true` sends the same
 * request as the one entry of a Message Batch (`submitBatch`) and reads it back once the
 * batch has ended (`pollBatch`).
 */
export function createAnthropicProvider(opts: AnthropicAdapterOptions = {}): ProviderFactory {
  return (provider) => {
    const client = new Anthropic({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers,
      maxRetries: 0,
      fetch: opts.fetch,
    });
    const adapter: LlmProvider = {
      name: provider.name,
      type: provider.type,
      complete: (req) => complete(client, req),
      submitBatch: (req) => submitBatch(client, req),
      pollBatch: (req) => pollBatch(client, req),
    };
    return adapter;
  };
}

export const anthropicProvider: ProviderFactory = createAnthropicProvider();

/**
 * The Messages API params for one request, shared by the synchronous call and a batch
 * entry: a cached system block, the input as the one user turn, adaptive thinking and
 * `output_config.effort` on models that take them, the schema as a plain `json_schema`
 * format.
 */
function requestParams(req: LlmRequest): Anthropic.MessageCreateParamsNonStreaming {
  const effortOk = supportsEffort(req.model);
  const outputConfig: Anthropic.OutputConfig = {
    ...(effortOk && req.effort !== undefined ? { effort: req.effort } : {}),
    ...(req.outputSchema === undefined
      ? {}
      : { format: { type: 'json_schema', schema: req.outputSchema } }),
  };
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [{ role: 'user', content: req.input }],
    ...(req.system === undefined
      ? {}
      : {
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        }),
    ...(effortOk ? { thinking: { type: 'adaptive' } } : {}),
    ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
  };
}

async function complete(client: Anthropic, req: LlmRequest): Promise<LlmResponse> {
  const params = requestParams(req);
  const options = { signal: req.signal, timeout: HTTP_TIMEOUT_MS };

  try {
    const schema = params.output_config?.format?.schema;
    if (schema === undefined) {
      const msg = await client.messages.create(params, options);
      return { output: null, text: textOf(msg), usage: usageOf(msg), stopReason: stopOf(msg) };
    }
    // `messages.parse()` takes the same format with its own `parse`.
    const format = {
      type: 'json_schema' as const,
      schema,
      parse: (text: string) => JSON.parse(text) as JsonValue,
    };
    const msg = await client.messages.parse(
      { ...params, output_config: { ...params.output_config, format } },
      options,
    );
    const stopReason = stopOf(msg);
    if (msg.parsed_output === null && stopReason === 'end') {
      throw new Error('anthropic: the response ended without a structured output');
    }
    return { output: msg.parsed_output, usage: usageOf(msg), stopReason };
  } catch (err) {
    throw mapError(err);
  }
}

/** `custom_id`s and batch ids go into URLs and a wait filter: nothing but these characters. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

async function submitBatch(
  client: Anthropic,
  req: BatchSubmitRequest,
): Promise<{ batchId: string }> {
  if (!ID.test(req.customId)) {
    throw new NonRetryableError(`anthropic: invalid batch custom_id "${req.customId}"`);
  }
  const params = requestParams(req);
  try {
    const batch = await client.messages.batches.create(
      { requests: [{ custom_id: req.customId, params }] },
      { signal: req.signal, timeout: HTTP_TIMEOUT_MS },
    );
    if (!ID.test(batch.id)) {
      throw new Error(`anthropic: unexpected batch id "${batch.id}"`);
    }
    return { batchId: batch.id };
  } catch (err) {
    throw mapError(err);
  }
}

async function pollBatch(client: Anthropic, req: BatchPollRequest): Promise<BatchStatus> {
  const options = { signal: req.signal, timeout: HTTP_TIMEOUT_MS };
  try {
    const batch = await client.messages.batches.retrieve(req.batchId, {}, options);
    if (batch.processing_status !== 'ended') {
      return { status: 'in_progress' };
    }
    const results = await client.messages.batches.results(req.batchId, {}, options);
    for await (const entry of results) {
      if (entry.custom_id === req.customId) {
        return outcomeOf(entry.result, req.structured);
      }
    }
    throw new NonRetryableError(
      `anthropic: batch ${req.batchId} ended without a result for ${req.customId}`,
    );
  } catch (err) {
    throw mapError(err);
  }
}

function outcomeOf(
  result: Anthropic.Messages.MessageBatchResult,
  structured: boolean,
): BatchStatus {
  switch (result.type) {
    case 'succeeded': {
      const msg = result.message;
      const stopReason = stopOf(msg);
      const text = textOf(msg);
      const usage = usageOf(msg);
      if (!structured) {
        return { status: 'succeeded', response: { output: null, text, usage, stopReason } };
      }
      if (stopReason !== 'end') {
        return { status: 'succeeded', response: { output: null, usage, stopReason } };
      }
      try {
        return {
          status: 'succeeded',
          response: { output: JSON.parse(text) as JsonValue, usage, stopReason },
        };
      } catch {
        return {
          status: 'succeeded',
          response: { output: null, usage, stopReason },
          error: 'anthropic: the batch response ended without a structured output',
        };
      }
    }
    case 'errored': {
      const e = result.error.error;
      return {
        status: 'errored',
        error: `anthropic: ${e.type}: ${e.message}`,
        retryable: e.type !== 'invalid_request_error',
      };
    }
    case 'expired':
      return {
        status: 'expired',
        error: 'anthropic: the batch expired before the request was processed',
        retryable: true,
      };
    case 'canceled':
      return {
        status: 'canceled',
        error: 'anthropic: the batch was canceled',
        retryable: true,
      };
  }
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function usageOf(msg: Anthropic.Message): LlmResponse['usage'] {
  return {
    input: msg.usage.input_tokens,
    output: msg.usage.output_tokens,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function stopOf(msg: Anthropic.Message): StopReason {
  switch (msg.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Never puts the key in a message: the SDK's messages carry the status and the API's own
 * error text only. An abort (`signal`) is rethrown untouched for the executor to classify.
 */
function mapError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) {
    return err;
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return new NonRetryableError(describe(err), { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(describe(err), { cause: err });
  }
  if (err instanceof Anthropic.AnthropicError) {
    return new Error(`anthropic: ${err.message}`, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** `anthropic: 401 authentication_error: API key is invalid.` rather than the raw JSON body. */
function describe(err: { status?: number | undefined; error?: unknown; message: string }): string {
  const body = err.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  const type = body?.error?.type;
  const message = body?.error?.message;
  if (typeof message === 'string') {
    const status = err.status === undefined ? '' : `${String(err.status)} `;
    const kind = typeof type === 'string' ? `${type}: ` : '';
    return `anthropic: ${status}${kind}${message}`;
  }
  return `anthropic: ${err.message}`;
}
