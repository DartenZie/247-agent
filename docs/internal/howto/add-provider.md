# Add a model provider type

A provider type is one adapter behind the `ctx.llm` port; the port keeps pricing,
budgets and the ledger, the adapter maps one request and response shape onto a vendor
SDK. `../model-actions.md` has the port's contract.

1. **Name the type.** Add it to the `ProviderType` enum in `packages/core/src/llm/config.ts`
   and to the `ProviderFactories` map the service is built with in `core.ts`. Done when
   `agent.yaml` with `providers: { x: { type: <new>, api_key: "${secrets.x}" } }` passes
   `oa validate`.
2. **Write the adapter** `llm/<type>.ts` implementing `LlmProvider` from `llm/types.ts`:
   `call` (and `decide`, `submitBatch`/`pollBatch` only if the vendor has such APIs).
   Rules: a per-call client with `maxRetries: 0` and an explicit HTTP timeout, because
   retries are the task's `retry` policy and the run's `timeout` is the real bound; the
   system prompt first with a cache marker where the vendor has one, the input as the
   user turn, no assistant prefill; the JSON Schema passed unchanged as the vendor's
   structured-output format (OpenAI-style strict mode needs every property in `required`
   and `additionalProperties: false`, and that is the schema author's job, not the
   adapter's); `effort` sent only on models that take it (`llm/models.ts`); usage
   normalised so `input` is what the vendor bills at the full input price and cache
   reads and writes are separate; a reported cost returned as `reportedUsd` when the
   vendor gives one; stop reasons mapped to `end | max_tokens | refusal | other`; a
   structured response that is not JSON thrown as a plain `Error` (retryable). Error
   classes: 400, 401, 403, 404 and 422 are `NonRetryableError`, everything else (429,
   5xx, 409, connection and SDK errors) a plain `Error`; an abort is rethrown as is; the
   key never appears in a message. Done when the adapter test drives the real SDK through
   `recordingFetch()` from `llm/testing.ts` and asserts the wire shape, the usage mapping
   and the error split.
3. **Prices.** Add the vendor's current models to `BUILTIN_PRICES` in `llm/pricing.ts`
   with a "checked on" date in the comment, or, when the vendor reports cost per
   response, add the type to the exemption in `config/crosscheck.ts` (`checkLlmTasks`)
   and in `pricing.ts` so an unpriced model on that type is accepted. Done when `oa
   validate` refuses an unknown model on the type unless `pricing:` names it, or accepts
   it when the type reports cost.
4. **Cross-checks.** If the type cannot serve `decide` or batches, nothing to do: the
   service refuses with `ProviderUnavailableError` when the adapter lacks the method. If
   it can, extend the `decide` provider-type check and the `batch: true` check in
   `config/crosscheck.ts` to accept it. Done when `config/crosscheck.test.ts` covers the
   new type.
5. **Document it**: the provider table in `docs/tasks/llm.md` and
   `docs/concepts/models-and-cost.md`, the `providers` and price rows in
   `docs/reference/agent-yaml.md`, the adapter notes in `docs/internal/model-actions.md`,
   and the `247-agent-model-actions` skill (`SKILL.md` model table and
   `references/llm-action.md` adapter notes). Done when `node scripts/check-docs.mjs
   docs skills` passes.
6. **Verify** with the `verify` skill: baseline (the adapter tests against the recorded
   wire), and the daemon rung with a task on the new type refused by budget before any
   call reaches the network, to prove the port wiring. There is no live-key rig, so the
   report says "not verified live: <type> adapter against the real API" and names the
   test that drove the SDK instead.
