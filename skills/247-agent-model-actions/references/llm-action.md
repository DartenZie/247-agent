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
  gpt-5-mini: { input: 0.25, output: 2 }      # USD per Mtok; cache_read/cache_write default to input
defaults:
  llm: { provider: anthropic, model: claude-haiku-4-5, max_tokens: 1024 }
budgets: { daily_usd: 10 }
```

- `api_key` must be a single `${secrets.<name>}` reference; a literal is rejected.
- Built-in prices cover the Claude models. Any other model needs a `pricing:` entry,
  except on an `openrouter` provider, which reports the cost per response.
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
- OpenAI: Responses API, `text.format` json_schema strict, `reasoning.effort` on
  reasoning models; `input` = `input_tokens - cached_tokens`.
- OpenRouter: the `openai` SDK against `https://openrouter.ai/api/v1`, Chat Completions
  with `response_format` json_schema; `usage.cost` → `reportedUsd`.
- Auth/bad-request errors → `NonRetryableError`; rate limits and 5xx → plain `Error`
  (retried by the task's policy). Never log or embed the key.
- Tests use `fakeProviderFactory()` from `src/llm/testing.ts`, never the network.
