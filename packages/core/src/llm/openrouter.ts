import type OpenAI from 'openai';

import { NonRetryableError } from '../actions/types.js';
import type { Effort } from './config.js';
import {
  cacheTokensOf,
  createClient,
  HTTP_TIMEOUT_MS,
  mapError,
  normaliseUsage,
  parseStructured,
  type FetchLike,
  type OpenAiCompatOptions,
} from './openai-compat.js';
import type {
  DecideAnswer,
  DecideRequest,
  DecideResponse,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ProviderFactory,
  ResolvedProvider,
  StopReason,
} from './types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** The Decisions API lives beside `/api/v1`, not under it; resolved against the base URL's origin. */
const DECISIONS_PATH = '/api/alpha/decisions';
const PREFIX = 'openrouter';

/**
 * OpenRouter's `reasoning` extension (openrouter.ai/docs/use-cases/reasoning-tokens) is not
 * in the SDK's Chat Completions types; models without reasoning ignore it.
 */
type Params = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  reasoning?: { effort: Effort };
};

/**
 * The `openrouter` provider type (ARCHITECTURE §5.2, llm-action.md "Adapter notes"): the
 * `openai` SDK against OpenRouter's Chat Completions endpoint. System prompt as the system
 * message, the input as the single user turn, the schema as a strict `response_format`,
 * `effort` passed through as OpenRouter's `reasoning.effort`. Every response carries
 * `usage.cost` in USD, which becomes `reportedUsd` so the ledger needs no price table for
 * OpenRouter models. Retries are the task's `retry` policy.
 *
 * `decide` (ARCHITECTURE §5.3) is OpenRouter's Decisions API (`POST /api/alpha/decisions`),
 * which the `openai` SDK does not know, so it is a plain `fetch` with the same key, headers
 * and error rules.
 */
export function createOpenRouterProvider(opts: OpenAiCompatOptions = {}): ProviderFactory {
  return (provider) => {
    const client = createClient(provider, DEFAULT_BASE_URL, opts);
    const transport: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const adapter: LlmProvider = {
      name: provider.name,
      type: provider.type,
      complete: (req) => complete(client, req),
      decide: (req) => decide(provider, transport, req),
    };
    return adapter;
  };
}

export const openrouterProvider: ProviderFactory = createOpenRouterProvider();

async function complete(client: OpenAI, req: LlmRequest): Promise<LlmResponse> {
  const params: Params = {
    model: req.model,
    messages: [
      ...(req.system === undefined ? [] : [{ role: 'system' as const, content: req.system }]),
      { role: 'user' as const, content: req.input },
    ],
    max_tokens: req.maxTokens,
    ...(req.outputSchema === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema' as const,
            json_schema: { name: 'output', schema: req.outputSchema, strict: true },
          },
        }),
    ...(req.effort === undefined ? {} : { reasoning: { effort: req.effort } }),
  };

  let res: OpenAI.ChatCompletion;
  try {
    res = await client.chat.completions.create(params, {
      signal: req.signal,
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    throw mapError(PREFIX, err);
  }
  const choice = choiceOf(res);
  const refused = typeof choice.message.refusal === 'string' && choice.message.refusal !== '';
  const stopReason: StopReason = refused ? 'refusal' : stopOf(choice.finish_reason);
  const text = choice.message.content ?? '';
  const usage = usageOf(res);
  if (req.outputSchema === undefined) {
    return { output: null, text, usage, stopReason };
  }
  if (stopReason !== 'end') {
    return { output: null, usage, stopReason };
  }
  if (text === '') {
    throw new Error(`${PREFIX}: the response ended without a structured output`);
  }
  return { output: parseStructured(PREFIX, text), usage, stopReason };
}

/** A 200 with an `error` body and no choices is how some upstream failures arrive; say so. */
function choiceOf(res: OpenAI.ChatCompletion): OpenAI.ChatCompletion.Choice {
  const body: { error?: { message?: unknown }; choices?: OpenAI.ChatCompletion.Choice[] } = res;
  const choice = body.choices?.[0];
  if (choice !== undefined) {
    return choice;
  }
  const message = body.error?.message;
  throw new Error(
    typeof message === 'string'
      ? `${PREFIX}: ${message}`
      : `${PREFIX}: the response has no choices`,
  );
}

function stopOf(reason: OpenAI.ChatCompletion.Choice['finish_reason']): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** What the Decisions API answers with; every field checked before use. */
interface DecisionsBody {
  id?: unknown;
  provider?: unknown;
  answers?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } | undefined;
  error?: { message?: unknown; code?: unknown; type?: unknown } | undefined;
}

/**
 * One Decisions request: `{model, state, questions}` as-is, the key in `Authorization` only,
 * bounded by the run's `signal` (an abort is rethrown untouched for the executor) and the
 * same HTTP timeout as the SDK clients. 4xx other than 429 is the config's fault
 * (`NonRetryableError`: bad question shape, no credits, a state over the 32k-token limit);
 * 429, 5xx, transport failures and a malformed body are the task's `retry` policy's business.
 */
async function decide(
  provider: ResolvedProvider,
  transport: FetchLike,
  req: DecideRequest,
): Promise<DecideResponse> {
  const url = new URL(DECISIONS_PATH, provider.baseUrl ?? DEFAULT_BASE_URL);
  let res: Response;
  try {
    res = await transport(url.href, {
      method: 'POST',
      headers: {
        ...provider.headers,
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: req.model, state: req.state, questions: req.questions }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (req.signal.aborted) {
      throw err;
    }
    throw new Error(`${PREFIX}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  let body: DecisionsBody;
  try {
    body = (await res.json()) as DecisionsBody;
  } catch (err) {
    if (!res.ok) {
      throw decisionsError(res.status, undefined);
    }
    throw new Error(`${PREFIX}: the decision response is not JSON (status ${String(res.status)})`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw decisionsError(res.status, body.error);
  }
  if (body.error !== undefined) {
    const message = body.error.message;
    throw new Error(
      typeof message === 'string' ? `${PREFIX}: ${message}` : `${PREFIX}: the decision failed`,
    );
  }
  const answers = answersOf(body.answers);
  if (answers === undefined) {
    throw new Error(`${PREFIX}: the decision response has no answers`);
  }
  return {
    answers,
    usage: decisionUsageOf(body.usage),
    id: typeof body.id === 'string' ? body.id : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
  };
}

/** `openrouter: 402 insufficient_quota: …` from the body's `error` object; never the key or the raw body. */
function decisionsError(status: number, error: DecisionsBody['error']): Error {
  const message = typeof error?.message === 'string' ? error.message : 'request failed';
  const kind =
    typeof error?.code === 'string' && error.code !== ''
      ? `${error.code}: `
      : typeof error?.type === 'string'
        ? `${error.type}: `
        : '';
  const text = `${PREFIX}: ${String(status)} ${kind}${message}`;
  return status === 429 || status >= 500 ? new Error(text) : new NonRetryableError(text);
}

/** The answers map when every entry is an object with a string `type`; the runner checks the rest. */
function answersOf(value: unknown): Record<string, DecideAnswer> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') {
      return undefined;
    }
  }
  return value as Record<string, DecideAnswer>;
}

function decisionUsageOf(u: DecisionsBody['usage']): LlmUsage {
  const usage: LlmUsage = {
    input: typeof u?.input_tokens === 'number' ? u.input_tokens : 0,
    output: typeof u?.output_tokens === 'number' ? u.output_tokens : 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return typeof u?.cost === 'number' ? { ...usage, reportedUsd: u.cost } : usage;
}

function usageOf(res: OpenAI.ChatCompletion): LlmUsage {
  // `cost` (USD) is OpenRouter's extension to the usage block.
  const u: (OpenAI.CompletionUsage & { cost?: unknown }) | undefined = res.usage;
  if (u === undefined) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const usage = normaliseUsage({
    input: u.prompt_tokens,
    output: u.completion_tokens,
    ...cacheTokensOf(u.prompt_tokens_details),
  });
  return typeof u.cost === 'number' ? { ...usage, reportedUsd: u.cost } : usage;
}
