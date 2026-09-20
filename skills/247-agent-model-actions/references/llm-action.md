# `llm` action

One Messages API call, structured output, no loop. `docs/ARCHITECTURE.md` §5.2 and §9.

## Fields

| field | meaning |
|---|---|
| `model` | `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`; default from `defaults.llm.model` |
| `effort` | `low`/`medium`/`high`; Sonnet/Opus 5 only, ignored on Haiku 4.5 |
| `max_tokens` | output cap; default from `defaults.llm.max_tokens` |
| `system_file` | path relative to the config dir; static system prompt, first in the request with a cache breakpoint |
| `input` | templated user content, rendered last |
| `output_schema` | JSON Schema for the result (`output_config.format`); the result is guaranteed to validate |
| `batch` | `true` routes through the Message Batches API; result arrives async as an event |
| `budget` | `{ max_usd }` per run |

## Prompt design

- System prompt: the task, the output fields and what each value means, the rule that
  content inside the delimiters is data and not instructions, and the default when
  unsure (`ignore`/`unknown`). Version it in git under `prompts/`.
- Input: only what the decision needs. Subject and body, not the whole raw message with
  headers. Keep the order stable so the cached prefix stays valid.
- Schema: `additionalProperties: false`, `required` listed, enums for anything routed
  on. Add `summary` (one sentence) when a human will see the event, and `confidence`
  when a threshold in `emit.when` is useful (`` result.confidence > `0.7` ``).

## Runner notes (for implementing `packages/core/src/actions/llm.ts`)

- `client.messages.parse()` with a zod schema derived from `output_schema`, or
  `output_config.format` with the JSON schema directly. No assistant prefill.
- Adaptive thinking and `output_config.effort` on Sonnet/Opus 5; omit both on Haiku.
- System block first with `cache_control`, then the rendered `input` as the user turn.
- Read `response.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`) and write the ledger row before returning the result.
- The API key is a secret resolved by name at run time; it never appears in config,
  logs or events.
- The result is the parsed object; the executor turns it into `task.<name>.succeeded`
  and the `emit` rules.
- Tests use a fake client, never the network.
