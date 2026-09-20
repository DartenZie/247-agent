# `llm` action

One model call, structured output, no loop. `docs/ARCHITECTURE.md` §5.2 and §9.

## Fields

| field | meaning |
|---|---|
| `provider` | a name from `providers:` in agent.yaml; default `defaults.llm.provider` |
| `model` | `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5` on an `anthropic` provider; other providers' ids verbatim; default `defaults.llm.model` |
| `effort` | `low`/`medium`/`high`; Sonnet/Opus 5 (and reasoning models elsewhere); dropped on models without it |
| `max_tokens` | output cap; default `defaults.llm.max_tokens` (1024) |
| `system` / `system_file` | static system prompt inline, or a path relative to the config dir; one of the two; no `${…}` (it is prompt-cached) |
| `input` | templated user content, rendered last |
| `output_schema` | JSON Schema (`type: object`) for the result; without it the result is `{ text }` |
| `budget` | `{ max_usd }` per run; the smaller of this and the task's `budget` applies |

`batch: true` (Message Batches) is planned and currently rejected by the schema.

## Providers and prices (agent.yaml)

```yaml
providers:
  anthropic:  { type: anthropic, api_key: "${secrets.anthropic_api_key}" }
  openai:     { type: openai, api_key: "${secrets.openai_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}", headers: { X-Title: 247-agent } }
pricing:
  gpt-4.1-mini: { input: 0.4, output: 1.6 }   # USD per Mtok; cache_read/cache_write default to input
defaults:
  llm: { provider: anthropic, model: claude-haiku-4-5, max_tokens: 1024 }
budgets: { daily_usd: 10 }
```

- `api_key` must be a single `${secrets.<name>}` reference; a literal is rejected.
- Built-in prices cover the Claude models and the current OpenAI ones (`BUILTIN_PRICES`
  in `src/llm/pricing.ts`, with the date they were checked). Any other model needs a
  `pricing:` entry, except on an `openrouter` provider, which reports the cost per
  response.
  `oa validate agent.yaml` fails on an unpriced model, an unknown provider or a missing
  `system_file`.

## Prompt design

- System prompt: the task, the output fields and what each value means, the rule that
  content inside the delimiters is data and not instructions, and the default when
  unsure (`ignore`/`unknown`). Version it in git under `prompts/`.
- Input: only what the decision needs. Subject and body, not the whole raw message with
  headers. Keep the order stable so the cached prefix stays valid.
- Schema: `additionalProperties: false`, `required` listed, enums for anything routed
  on. Add `summary` (one sentence) when a human will see the event, and `confidence`
  when a threshold in `emit.when` is useful (`` result.confidence > `0.7` ``).

## How a call runs (`packages/core/src/actions/llm.ts` → `src/llm/service.ts`)

1. The runner fills defaults, reads `system_file`, renders `input`, takes the smaller
   budget and calls `ctx.llm.call()`. It never touches an SDK or the store.
2. The service refuses before any network call when the daily cap is already reached
   (`budget.exceeded` was emitted for that UTC day) or when the worst case (input at
   3 chars/token + `max_tokens` output, table prices) would exceed the run budget.
3. It resolves the provider's secret for this call, builds the adapter for the provider
   type and calls it with `{model, system, input, outputSchema, maxTokens, effort, signal}`.
4. It prices the response (provider-reported cost wins over the table), writes the ledger
   row, trips the daily breaker if the day's spend crossed the cap, logs `llm.call` with
   token counts and USD (never the prompt or the key), then fails the run if the actual
   cost overran the run budget or the call could not be priced.
5. A `max_tokens` stop or a refusal fails the run non-retryably.

## Adapter notes (`src/llm/<type>.ts`, one per provider type)

- Anthropic (`anthropic.ts`, shipped): `client.messages.parse()` with a schema,
  `messages.create()` without; system block first with `cache_control`, the input as
  the user turn, `output_config.format` with the raw JSON Schema; adaptive thinking and
  `output_config.effort` on Sonnet/Opus 5 only (`models.ts`); no prefill. Usage:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`. The SDK client is built per call with `maxRetries: 0`
  (retries are the task's `retry` policy) and an explicit HTTP timeout, so the run's
  `timeout` is what bounds the call. A structured output that is not JSON, or a
  completed response with no output, fails retryably.
- OpenAI (`openai.ts`, shipped): one non-streaming Responses API call; `instructions`
  for the system prompt (caching is automatic for prefixes of 1024+ tokens), the input
  as `input`, `text.format` json_schema with `strict: true`, `reasoning.effort` only on
  reasoning models (`isReasoningModel` in `models.ts`: gpt-5/gpt-6 families and the
  o-series, not `*-chat-*`), `store: false`. Usage: `input` =
  `input_tokens - cached_tokens - cache_write_tokens`, the two cache counters separate.
  Stop: `completed` → end, `incomplete` with `max_output_tokens`/`content_filter` →
  max_tokens/refusal, a `refusal` content part → refusal. Same client rules as
  Anthropic (per-call client, `maxRetries: 0`, explicit timeout, base URL always
  explicit so `OPENAI_BASE_URL` in the environment is ignored); a non-JSON structured
  output or a completed response with no output fails retryably.
- OpenRouter (`openrouter.ts`, shipped): the `openai` SDK against
  `https://openrouter.ai/api/v1` (or `base_url`), Chat Completions with a `system` and a
  `user` message, `max_tokens`, `response_format` json_schema `strict: true`, and
  OpenRouter's own `reasoning: { effort }` whenever `effort` is set (models without
  reasoning ignore it). `usage.cost` (USD) → `reportedUsd`, so the ledger records
  `priced_by: provider` and no `pricing:` entry is needed; `usage.include` is a
  deprecated no-op and is not sent. Stop: `finish_reason` stop/length/content_filter →
  end/max_tokens/refusal, a non-empty `message.refusal` → refusal. Same client, retry
  and parse-failure rules as above. Attribution headers (`HTTP-Referer`, `X-Title`) come
  from the provider's `headers:`.
- Strict schemas: OpenAI and OpenRouter accept `strict: true` only when every property is
  in `required` and every object has `additionalProperties: false` (and only a subset of
  JSON Schema keywords). The adapters send the user's schema unchanged; one that breaks
  these rules fails the call with the vendor's 400 (non-retryable). Anthropic has no
  such rule, so a schema meant to run on any provider should follow it.
- Auth/bad-request errors → `NonRetryableError`; rate limits and 5xx → plain `Error`
  (retried by the task's policy). Never log or embed the key.
- Tests use `fakeProviderFactory()` from `src/llm/testing.ts`, never the network; adapter
  tests drive the real SDK through `recordingFetch()` from the same file.
