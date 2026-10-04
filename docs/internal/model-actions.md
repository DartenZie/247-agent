# Model actions: the `ctx.llm` port, `llm`, `decide`, batches

How every direct model call is priced, budgeted and ledgered, and the contracts of the
`llm` and `decide` runners and the provider adapters. Open it when touching
`packages/core/src/llm/`, `actions/llm.ts`, `actions/decide.ts`, `pricing:`,
`providers:`, `budgets:` or `batches:`. The `agent` action uses the same port for its
turns; see [`agent-action.md`](agent-action.md). The user-facing pages are
[`../tasks/llm.md`](../tasks/llm.md), [`../tasks/decide.md`](../tasks/decide.md) and
[`../concepts/models-and-cost.md`](../concepts/models-and-cost.md).

## The port

`llm/types.ts`, `LlmPort`, implemented by `llm/service.ts` (`LlmService`): `call`,
`decide`, `submitBatch`, `batchResult`, `pollBatches`, `checkBudget`, `record`,
`readSystemFile`, `providers`, plus the `defaults` it was configured with. Runners see
nothing else: no SDK, no store, no provider key. The invariants:

- Every call is priced, checked against the run's cap and the daily cap, and written
  to the ledger, in the service, in one place. A runner that needs a model gets it
  through `ctx.llm`; adding a "helper" call elsewhere is a bug.
- The service resolves the provider's `api_key` and `headers` secrets per call and
  hands them to a freshly built adapter; keys never reach a runner, a log line or an
  error message.
- Provider adapters (`llm/anthropic.ts`, `llm/openai.ts`, `llm/openrouter.ts`, the
  shared `llm/openai-compat.ts`) map one request shape to one vendor SDK and back,
  and nothing more. `llm/testing.ts` has `fakeLlmPort`, `fakeProviderFactory()` and
  `recordingFetch()` for tests; nothing in `npm test` reaches a provider.
- The service survives a reload through `configure()`: providers, pricing, defaults,
  budgets and the batch interval change live.

## Providers and prices

`llm/config.ts`: `providers.<name>` is `{type: anthropic | openai | openrouter,
api_key, base_url?, headers?}`; `api_key` must be exactly one `${secrets.<name>}`.
`defaults.llm` is `{provider?, model?, max_tokens: 1024, effort?}`, `defaults.decide`
is `{provider?, model: typesafe/jev-1.13}`.

`llm/pricing.ts` holds `BUILTIN_PRICES` in USD per million tokens (input, output,
cache read, cache write, with the date they were checked) for the Claude models, the
current OpenAI models and Jev (`typesafe/jev-1.13`, `~typesafe/jev-latest`: input
0.042, output 0). `pricing:` in `agent.yaml` is merged over it; `cache_read` and
`cache_write` default to the input price. Prices are never guessed: a model without a
price fails `oa validate` unless its provider is an `openrouter` one, which reports
cost per response, and an unpriced response at run time fails the run (below).

## One call, step by step

`actions/llm.ts` fills defaults, reads `system_file` through the port (relative to the
`agent.yaml` directory and kept under it; `system`/`system_file` are exclusive and may
not contain `${`), renders `input`, takes the smaller of the action's and the task's
`budget.max_usd`, and calls `ctx.llm.call()`. `max_tokens` is at most 128 000;
`effort` is `low | medium | high`. The service (`LlmService.call`):

1. **Precheck** (`precheck()`): refuses with `BudgetExceededError('daily')` when the
   day's ledger sum (UTC day, `pricing.ts`) has reached `budgets.daily_usd`, and with
   `BudgetExceededError('task')` when the run has already spent its cap. When the
   model has a table price, the worst case is also checked: `ceil(len(system + input)
   / 3)` input tokens plus `max_tokens` output at table prices, added to what the run
   has spent, must fit the cap. An `openrouter` model without a `pricing:` entry has no
   table price, so it gets only the post-hoc check. `spentRun` is the ledger sum for
   the run id, so retries share one cap.
2. **Call** the adapter with `{model, system, input, outputSchema, maxTokens, effort,
   signal}`.
3. **Settle** (`settle()`): price the response. A provider-reported cost wins
   (`priced_by: provider`); else the table (`table`); else the row is written at $0
   with `priced_by: unpriced` and `UnpricedModelError` fails the run so it is noticed.
   Write the ledger row, trip the daily breaker when `spentToday + usd` reaches the
   cap (the crossing call still returns its result), log `llm.call` with token counts
   and USD, never the prompt or the key.
4. **Overrun** (`overrun()`): if the run's sum now exceeds its cap,
   `BudgetExceededError('task')`, non-retryable, the row kept.

Back in the runner: a `max_tokens` stop fails non-retryably ("output truncated at
max_tokens N; raise it or shorten the task"), so does a refusal; the result is the
parsed object with `output_schema`, else `{text}`.

## The daily breaker

`budgets.daily_usd` is derived from the ledger per UTC day, so a restart changes
nothing. Once tripped, every `call`, `decide`, batch submit and agent `checkBudget`
fails fast without contacting a provider until 00:00 UTC. The first crossing publishes
`budget.exceeded` with `dedup_key: budget:daily:<YYYY-MM-DD>` (so once per day),
`source: core`, payload `{scope, day, limit_usd, spent_usd, task, run_id}`; a `notify`
task should listen for it. Batches in flight reserve their worst case against the cap.

## The ledger row

`store/ledger.ts`: `run_id, task, provider, model, in_tok, out_tok, cache_read,
cache_write, usd, priced_by, ts`, where `priced_by` is `provider`, `table` or
`unpriced`. Usage is normalised so `in_tok` is what the vendor bills at the full input
price and cache reads and writes are separate. `GET /v1/cost` and `oa cost` sum it by
task, model, provider or day; `GET /v1/runs/{id}/ledger` lists a run's rows. Rows of
a run that is still `queued`, `running` or `waiting` are never swept by retention.

## Adapters

One client per call (`maxRetries: 0`, HTTP timeout 1 h, base URL always explicit so
environment variables such as `OPENAI_BASE_URL` are ignored); the task `timeout` is
the real bound. Error classes are shared (`anthropic.ts`, `openai-compat.ts`): 400,
401, 403, 404 and 422 are `NonRetryableError`; every other API error (429, 5xx, 409),
connection and SDK errors are plain `Error`, retried by the task's policy; an abort is
rethrown as is. A structured response that ends without parseable JSON, or a
completed response with no output, is a retryable `Error`. Keys never appear in an
error message.

- **Anthropic** (`anthropic.ts`): `client.messages.parse()` with `output_config.format
  = {type: 'json_schema', schema}` when a schema is set, `messages.create()` otherwise;
  `system` as one text block with `cache_control: {type: 'ephemeral'}`; the input as
  the single user turn, no prefill; `thinking: {type: 'adaptive'}` and
  `output_config.effort` only when `supportsEffort(model)` (`llm/models.ts`:
  `claude-sonnet-5*`, `claude-opus-5*`); Haiku 4.5 gets neither. Usage maps
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`. Also `submitBatch`/`pollBatch` over
  `client.messages.batches` (below).
- **OpenAI** (`openai.ts`): one non-streaming `responses.create` with `instructions`
  for the system prompt (prefix caching is the vendor's, from 1024 tokens), `input`,
  `max_output_tokens`, `text.format = {type: 'json_schema', name: 'output', schema,
  strict: true}`, `store: false`, `reasoning.effort` only when `isReasoningModel`
  (`gpt-5`+ and the o-series, not `*-chat*`). Usage: `input` = `input_tokens −
  cached_tokens − cache_write_tokens`, the two cache counters separate. Stop:
  `completed` → end; `incomplete` with `max_output_tokens` / `content_filter` →
  `max_tokens` / refusal; a `refusal` part → refusal.
- **OpenRouter** (`openrouter.ts`): the `openai` SDK against
  `https://openrouter.ai/api/v1` (or `base_url`), Chat Completions with a `system` and a
  `user` message, `max_tokens`, `response_format` json_schema `strict: true`, and
  `reasoning: {effort}` whenever `effort` is set; `usage.cost` → `reportedUsd`, so the
  ledger says `provider` and no `pricing:` entry is needed. `finish_reason`
  stop/length/content_filter → end/max_tokens/refusal; a non-empty `message.refusal` →
  refusal. `HTTP-Referer`/`X-Title` come from the provider's `headers:`.
- **Strict schemas**: OpenAI and OpenRouter accept `strict: true` only when every
  property is in `required` and every object has `additionalProperties: false` (and a
  subset of JSON Schema keywords). The adapters send the user's schema unchanged; one
  that breaks the rule fails with the vendor's 400, non-retryable. Anthropic has no such
  rule, so a schema meant for any provider follows it.

## `decide`

`actions/decide.ts` → `LlmService.decide()` → `openrouter.ts`, `decide()`. The runner
fills `defaults.decide`, renders `state` (a whole-string `${…}` injects the raw value;
object keys are never templated; the result must be a non-empty string, object or
array), takes the smaller budget and calls the port. `questions` are static: the schema
refuses `${` in them; `choice` takes 2 to 255 labels, `score` 2 to 10 levels, `noul`
both criteria sides or neither.

The service runs the same precheck, settle and overrun as `call`, with the worst case
estimated from `JSON.stringify({state, questions})` at the input price and no output.
An adapter without `decide` (every type but `openrouter`) is
`ProviderUnavailableError`. The adapter is a plain `fetch` to
`POST /api/alpha/decisions`, resolved against the provider's `base_url` origin, with
`Authorization: Bearer` and the provider's headers: 429 and ≥ 500 → retryable `Error`;
any other non-2xx → `NonRetryableError` (400 bad question, 401 no key, 402 no credits,
413 over 32k tokens); a non-JSON body, a 2xx carrying `error`, or no `answers` map →
retryable. `usage.cost` is the price when reported, else the table.

The runner then checks every declared question is answered with its declared type, a
`choice` is one of its labels, a `score` is within `0..levels−1`, a `noul` is a number;
a mismatch is a retryable `Error` (the provider's fault); extra answers are dropped.
The result is the answers map keyed by question id. Jev is absent from
`/api/v1/models` and rejects `/chat/completions`: never route a `decide` model through
`llm` or the reverse.

## `batch: true`

Anthropic providers only (`oa validate` refuses the flag elsewhere); only
`anthropic.ts` implements `submitBatch`/`pollBatch`. The run goes through two entries,
like a wait:

1. `actions/llm.ts` calls `ctx.llm.submitBatch()`: the usual precheck with the worst
   case at the batch price (`batchPrice()`, factor 0.5); the day's spend plus the
   reservations of every batch in flight plus this worst case must fit the daily cap.
   One request per run (`custom_id` = the run id, ids `[A-Za-z0-9_-]{1,64}`), the same
   params as the synchronous call, a row in `llm_batches` with the reserved
   `worst_usd`. A run that already has a batch in flight gets that one back
   (`llm.batch_reused`), which is what makes a restart between submit and park safe.
   Nothing is ledgered yet. The runner parks the run with `ctx.suspend` on
   `llm.batch.ended` where `payload.batch_id` is its batch, timeout 25 h, `on_timeout:
   fail`; the wait timeout is non-retryable.
2. `BatchPoller` (`llm/batches.ts`) runs once at start and every `batches.poll`
   (default 1m, 1 s to 1 h; passes never overlap) and calls `pollBatches()`: one
   retrieve per batch in flight. Once a batch ended, in one transaction: the ledger row
   at the batch price (a billed result; `errored`, `expired` and `canceled` requests
   are not billed), the breaker, `llm.batch.ended` (`source: core`, `dedup_key:
   llm.batch:<id>`, parented to the run's trigger event so it keeps the correlation
   id) and the row's deletion. The payload is `{batch_id, run_id, task, provider,
   model, status}` plus `stop_reason`, `output` or `text`, `usage`, `usd`, `priced_by`,
   `ledger_id` when `succeeded`, else `error` and `retryable`. A batch whose run is
   gone is still settled (`llm.batch_orphaned`): the provider bills it anyway.
3. The event ends the wait; `ctx.llm.batchResult()` reads the payload and applies the
   post-hoc checks; the result, `max_tokens` and refusal handling are the synchronous
   call's, and `emit` routes as usual.

Failures: `errored` (other than `invalid_request_error`), `expired`, `canceled`, or a
billed structured output that is not JSON (published as `errored`, `retryable: true`)
fail the attempt retryably, and the retry submits a new batch; an invalid request or
the 25 h timeout fails the run for good. Retention keeps a run while it has a batch in
flight. A batch the poller cannot reach for 7 days (`BATCH_ABANDON_MS`: the provider
was removed, the key revoked) is deleted with `llm.batch_abandoned` and nothing
ledgered. The one gap, accepted in [`decisions.md`](decisions.md): the Batches API has
no idempotency key, so a daemon killed after Anthropic accepted a batch but before the
row was written loses track of it, and the retry submits again.

## Metrics and logs

`oa_model_calls_total`, `oa_model_tokens_total{direction}`,
`oa_model_cost_usd_total`, `oa_model_spend_today_usd`, `oa_model_daily_budget_usd`,
`oa_budget_exceeded_total{scope}`, `oa_llm_batches_total{provider,status}`,
`oa_llm_batches_pending` (`metrics.ts`). Log events: `llm.call`, `llm.decide`,
`llm.batch_submitted`, `llm.batch_reused`, `llm.batch_ended`, `llm.batch_orphaned`,
`llm.batch_abandoned`, `budget.exceeded`.

## Adding a provider type

[`howto/add-provider.md`](howto/add-provider.md).
