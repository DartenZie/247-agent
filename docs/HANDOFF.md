# Handoff: the model-backed path

Goal: `classify_orchestra_email` (`llm`) and `update_event_list` / `update_site_general`
(`agent`) in `docs/examples/orchestra-website.yaml` run on a real daemon, budgeted and
recorded in a cost ledger, with the model mocked in tests. Then a real `email` connector
and a `chat` connector so the whole workflow runs unattended.

Read `docs/ARCHITECTURE.md` first (§5.2, §5.3, §9, §14) and `CLAUDE.md` for the rules.

## What exists (all tested, `npm test` = 189 green, lint clean)

The non-LLM path is complete and exercised end to end by
`packages/core/src/integration.test.ts` (real daemon, fake email/chat connectors as child
processes, `manual.run` of `fetch_email` → … → `publish_site` → `notify`, one correlation
id, no secret in the DB, log or events):

- `${…}` templating (`src/expr/template.ts`) with reference analysis (secret names, roots).
- `emit` routing, `state_updates`, state KV + `/v1/state`, secrets backends
  (`src/secrets/`), `retry` with backoff and recovery by policy (`src/executor/`).
- `connector` action + supervisor (`src/connectors/supervisor.ts`), `wait` (suspend/resume
  through the `waits` table, matched and expired by the dispatcher) and `sequence`.
- `tasks.d`/`connectors.d` merging, connector manifests, `oa validate` for all three kinds.
- `packages/connector-sdk`: `connectorEnv`, `CoreClient`, `defineTool`,
  `createConnectorServer`, `serveStdio`, `runConnector`. Fixtures under
  `packages/core/test/fixtures/` show how a connector looks.

## Gaps, in the order to close them

1. **Cost ledger** (`ledger` table + `store/ledger.ts`): `run_id, task, model, in_tok,
   out_tok, cache_read, cache_write, usd`; per-task `budget.max_usd` and
   `budgets.daily_usd` as circuit breakers emitting `budget.exceeded`. Pricing table per
   model id in code, one place.
2. **`llm` action** (`src/actions/llm.ts`): `@anthropic-ai/sdk`, `client.messages.parse()`
   with `output_config.format` from `output_schema` (JSON schema → zod via `z.fromJSONSchema`
   or pass the JSON schema through), `system_file` first with a cache breakpoint, `input`
   templated last, `effort` only on Sonnet/Opus 5, `defaults.llm` applied. Usage → ledger.
   Tests use an injected fake client, never the network. Optional `batch: true` later.
3. **`agent` action** (`src/actions/agent.ts`): `@anthropic-ai/claude-agent-sdk` `query()`
   in a fresh git worktree under `work/<run_id>/`, `allowedTools`, `maxTurns`, a
   `PreToolUse` hook enforcing `bash_allow`, `mcp_servers` from the supervisor's manifests,
   `result.from: file` → `RESULT.json` validated against `result.schema`, `post` gates as
   shell steps, `run.workspace` in templates. No deploy secrets in the worktree env. Tests
   with a fake runtime.
4. **`poller` built-in** and a real **`email` connector** (imapflow + nodemailer) and
   **`chat` connector** (Telegram via grammy) under `connectors/`.
5. Hardening: retention GC, `/metrics`, `oa cost|runs|events|connectors` commands,
   SIGHUP reload of connectors.

## Conventions and gotchas

- One runner per file; the runner narrows `action` with its own zod schema and gets an
  `ActionContext` (`src/actions/types.ts`): `render`/`renderText`, `secrets`, `state`,
  `connectors`, `suspend`/`resume`. `NonRetryableError` stops retries.
- Never log payloads; `Logger` fields are scalars. Secrets only in `ctx.secrets` and
  connector env.
- Node runs `.ts` fixtures directly; keep the connector SDK free of local imports.
- macOS Unix socket paths max 104 bytes; tests use short temp dirs.
- `npm run lint` is strict (`strictTypeChecked`); `expect.stringMatching(...) as string`
  inside object matchers.

## Done when

- `oa validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml` passes.
- An integration test with a fake model client runs `email.received` → classify (llm) →
  `orchestra.classified` → agent (fake runtime writing `RESULT.json`) → build gate →
  `publish_site`, with ledger rows for both model calls and `budget.exceeded` emitted when
  a cap is hit.
