import type OpenAI from 'openai';

import { isReasoningModel } from './models.js';
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const PREFIX = 'openai';

/**
 * The `openai` provider type (ARCHITECTURE §5.2, llm-action.md "Adapter notes"): one
 * non-streaming Responses API call per request. The static system prompt goes in
 * `instructions` (prompt caching is automatic for prefixes of 1024+ tokens), the input as
 * the single user turn, the schema as a strict `text.format`, `reasoning.effort` only on
 * models that take it (`models.ts`). `store: false`: the daemon never reads a response
 * back, so nothing stays on OpenAI's side. Retries are the task's `retry` policy.
 */
export function createOpenAiProvider(opts: OpenAiCompatOptions = {}): ProviderFactory {
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

export const openaiProvider: ProviderFactory = createOpenAiProvider();

async function complete(client: OpenAI, req: LlmRequest): Promise<LlmResponse> {
  const effort = isReasoningModel(req.model) ? req.effort : undefined;
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: req.model,
    input: req.input,
    max_output_tokens: req.maxTokens,
    store: false,
    ...(req.system === undefined ? {} : { instructions: req.system }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(req.outputSchema === undefined
      ? {}
      : {
          text: {
            format: {
              type: 'json_schema' as const,
              name: 'output',
              schema: req.outputSchema,
              strict: true,
            },
          },
        }),
  };

  let res: OpenAI.Responses.Response;
  try {
    res = await client.responses.create(params, { signal: req.signal, timeout: HTTP_TIMEOUT_MS });
  } catch (err) {
    throw mapError(PREFIX, err);
  }
  if (res.error !== null) {
    throw new Error(`${PREFIX}: ${res.error.code}: ${res.error.message}`);
  }
  const { text, refused } = contentOf(res);
  const stopReason: StopReason = refused ? 'refusal' : stopOf(res);
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

/** Joins the `output_text` parts of every message item; a `refusal` part marks the whole response. */
function contentOf(res: OpenAI.Responses.Response): { text: string; refused: boolean } {
  let text = '';
  let refused = false;
  for (const item of res.output) {
    if (item.type !== 'message') {
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'output_text') {
        text += part.text;
      } else {
        refused = true;
      }
    }
  }
  return { text, refused };
}

function stopOf(res: OpenAI.Responses.Response): StopReason {
  switch (res.status) {
    case 'completed':
      return 'end';
    case 'incomplete':
      switch (res.incomplete_details?.reason) {
        case 'max_output_tokens':
          return 'max_tokens';
        case 'content_filter':
          return 'refusal';
        default:
          return 'other';
      }
    default:
      return 'other';
  }
}

function usageOf(res: OpenAI.Responses.Response): LlmUsage {
  const u = res.usage;
  if (u === undefined) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return normaliseUsage({
    input: u.input_tokens,
    output: u.output_tokens,
    ...cacheTokensOf(u.input_tokens_details),
  });
}
