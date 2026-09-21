# `decide` action

One call to a classification-only model, typed answers with probabilities, no text.
`docs/ARCHITECTURE.md` §5.3 and §9; reference task in `docs/examples/decide-triage.yaml`.

## Fields

| field | meaning |
|---|---|
| `provider` | a name from `providers:` in agent.yaml, **of type `openrouter`**; default `defaults.decide.provider` |
| `model` | default `defaults.decide.model`, which defaults to `typesafe/jev-1.13`; `~typesafe/jev-latest` follows the newest Jev |
| `state` | what is judged: a templated string, or an object/array whose strings are templated (keys never are); a whole-string `${event.payload}` injects the raw value |
| `questions` | map of `[a-z][a-z0-9_]*` ids to typed questions (below); at least one; static, `${…}` is refused |
| `budget` | `{ max_usd }` per run; the smaller of this and the task's `budget` applies |

### Question types and answers

| type | question | answer |
|---|---|---|
| `noul` | `{ type, instructions, criteria?: { "true": "…", "false": "…" } }`; both sides or neither | `{ type: noul, noul }` where `noul` is P(true) in 0..1; no confidence field (0.5 means "cannot tell") |
| `choice` | `{ type, instructions, criteria: { label: description, … } }`; 2 to 255 labels | `{ type: choice, choice, confidence?, probabilities? }`; `choice` is the argmax, probabilities sum to 1 |
| `score` | `{ type, instructions, criteria: [lowest, …, highest] }`; 2 to 10 levels | `{ type: score, score, confidence?, probabilities?, legend? }`; `score` is Σ index × p(index), so `1.05` means "level 1, a little of level 2" |

The run result is the answers map keyed by question id, so `emit`/`state_updates` read
`result.kind.choice`, `result.kind.probabilities.ignore`, `result.urgent.noul`,
`result.anger.score`. The runner keeps only the configured ids and fails retryably when
an answer is missing, of another type, a `choice` outside the labels or a `score` outside
`0..levels-1` (the provider's fault; the next attempt may answer properly).

## Writing questions

- **Fallback label.** Every `choice` gets an `ignore`/`other`/`unknown` label. Measured:
  without one, two of three off-taxonomy inputs came back wrong at confidence 0.93+.
- **Criteria are policy.** The model applies the wording literally; misses trace to a
  criterion that said something other than what the author meant. Version them in git.
- **Order is stable.** Reordering labels on an ambiguous input moved the winning
  probability from 0.62 to 0.48; the choice held, the confidence did not. Do not shuffle.
- **Thresholds are the product decision.** `emit … when: result.kind.confidence > \`0.7\``
  or `payload.urgent > \`0.8\`` in a downstream filter; sweep the value on labelled data
  before pinning it. Rough bands: > 0.9 act, 0.5–0.9 confirm, < 0.5 escalate.
- **Batch questions.** Several questions in one call answer identically to separate calls
  and cost only their own tokens; one `state`, one request, one ledger row.
- **State is data.** Inbound content goes in `state` under a key that names it
  (`body`, `message`); the questions describe what to decide about it. Keep English
  questions even for non-English content (agreement drops when questions are translated).
- **Size.** The whole request must fit in 32k tokens; over it OpenRouter answers 413,
  which is non-retryable. Trim long bodies in the template, not in the model.

## How a call runs (`packages/core/src/actions/decide.ts` → `src/llm/service.ts` → `src/llm/openrouter.ts`)

1. The runner fills `defaults.decide`, renders `state` (refusing `null`/number/empty
   results), takes the smaller budget and calls `ctx.llm.decide()`. It never touches an
   SDK or the store.
2. The service runs the same path as an `llm` call: refuse on the daily cap, refuse when
   the worst case (the JSON body at 3 chars/token, input price, no output) would exceed
   the run budget, resolve the provider's secret, build the adapter. An adapter without a
   `decide` method (every type but `openrouter`) fails with `ProviderUnavailableError`.
3. The adapter posts `{model, state, questions}` to `POST /api/alpha/decisions` (resolved
   against the provider's `base_url` origin, default `https://openrouter.ai`) with
   `Authorization: Bearer` and the provider's `headers:`; the run's `signal` bounds it.
4. The service prices the response (`usage.cost` reported by OpenRouter wins; the built-in
   table knows Jev at $0.042/Mtok input, $0 output), writes the ledger row with the Jev
   model id, trips the daily breaker if crossed, logs `llm.decide` with token counts,
   USD, the question count and the upstream (never the state or the key), then fails the
   run if the actual cost overran the run budget.
5. The runner checks the answers against the questions and returns the map.

## Adapter notes (`src/llm/openrouter.ts`, `decide`)

- Plain `fetch` (the `openai` SDK has no Decisions support), injected in tests through
  the same `fetch` option as the Chat Completions path; `recordingFetch()` from
  `src/llm/testing.ts` drives it.
- 429 and 5xx → plain `Error` (the task's `retry` policy); every other non-2xx →
  `NonRetryableError` (400 bad question shape or `instructions: null`, 401 no key, 402
  no credits, 413 over 32k tokens). Messages are `openrouter: <status> <code>: <message>`
  from the body's `error`, never the key or the raw body.
- A 200 whose body carries `error`, is not JSON, or has no well-formed `answers` map is a
  retryable `Error`. An abort of the run's `signal` is rethrown untouched.
- Usage: `input_tokens` → `input`, `output_tokens` → `output`, no cache columns,
  `cost` → `reportedUsd`.
- Jev is absent from `/api/v1/models` and rejects `/chat/completions`; do not route a
  `decide` model through the `llm` action or vice versa.
- Tests: `actions/decide.test.ts` (schema and runner against `fakeLlmPort`),
  `llm/openrouter.test.ts` "decide" describe (wire shape, status map, abort),
  `llm/service.test.ts` "LlmService.decide" (ledger, budgets, breaker, capability check),
  `config/crosscheck.test.ts` (provider type), `config/agent.test.ts` (the example).
