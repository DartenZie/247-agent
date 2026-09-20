import type OpenAI from 'openai';

import type { Effort } from './config.js';
import {
  cacheTokensOf,
  createClient,
  HTTP_TIMEOUT_MS,
  mapError,
  normaliseUsage,
  parseStructured,
  type OpenAiCompatOptions,
} from './openai-compat.js';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ProviderFactory,
  StopReason,
} from './types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
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
 */
export function createOpenRouterProvider(opts: OpenAiCompatOptions = {}): ProviderFactory {
  return (provider) => {
    const client = createClient(provider, DEFAULT_BASE_URL, opts);
    const adapter: LlmProvider = {
      name: provider.name,
      type: provider.type,
      complete: (req) => complete(client, req),
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
