# 247-agent

A 24/7, config-driven automation daemon for a single Linux server. Tasks are declared in
YAML: each has a trigger (cron, event, manual) and an action (`shell`, `connector`, `llm`,
`decide`, `agent`, `wait`, `sequence`). Deterministic work never touches a model; model calls are
tiered and budgeted per task. Sub-programs ("connectors") emit events to the core and
expose operations as MCP servers.

Read `docs/ARCHITECTURE.md` before changing anything structural. It is the source of
truth for concepts, action semantics, the connector protocol and the config format.
`docs/examples/website-updates.yaml` is the reference workflow; keep it valid.

## Stack (decided)

- TypeScript, Node.js 22 LTS, npm workspaces. Strict TS, ESM.
- SQLite via `better-sqlite3` (WAL). Config schemas with `zod`. Cron with `croner`.
  Expressions with `jmespath`. YAML with `yaml`. Subprocesses with `execa`.
- LLM: `llm` actions go through the `ctx.llm` port (`packages/core/src/llm/`), which
  budgets and ledgers every call and dispatches to one adapter per provider type:
  `@anthropic-ai/sdk` (structured outputs via `client.messages.parse()` /
  `output_config.format`), `openai` for OpenAI and OpenRouter. Providers are named in
  `agent.yaml` (`providers:`), keys are `${secrets.<name>}` refs. `decide` actions go
  through the same port (`ctx.llm.decide`) to OpenRouter's Decisions API
  (`POST /api/alpha/decisions`, plain `fetch`, TypeSafe's Jev classifier); only the
  `openrouter` provider type serves it. `agent` actions use
  `@anthropic-ai/claude-agent-sdk`. MCP client from `@modelcontextprotocol/sdk`.
- Target runtime: systemd service on Linux, HTTP API over a Unix socket.

## Layout

```
packages/core/           daemon: config, store, bus, actions, connectors, executor, secrets, api, expr
packages/core/test/fixtures/  fake connectors for tests (Node runs them from .ts source)
packages/cli/            `oa` command, talks to the core socket
packages/connector-sdk/  helpers for writing TS connectors (single file, no local imports)
connectors/<name>/       one package per connector (email, chat, ...)
docs/                        ARCHITECTURE.md, examples/ (agent.yaml, website-updates.yaml, connectors.d/)
skills/                      agent skills for working with 247-agent (linked from .claude/skills; ship with builds)
```

## Rules

- Everything goes through events. Tasks reference event types, never other tasks.
  Do not add direct task-to-task calls.
- No LLM in the core's control flow. Matching, dedup, routing, retries, publishing are
  code. A model call happens only inside an `llm`, `decide` or `agent` action.
- Every model call records usage in the ledger and respects the task's `budget` and the
  global daily cap. Never add an unbudgeted call.
- Agents run in a fresh git worktree with an explicit tool/bash allowlist, produce a
  `RESULT.json`, and pass deterministic `post` gates. Agents never hold deploy secrets
  and never publish.
- Secrets are resolved by name from the configured backend at run time. Never write them
  to the DB, run logs, or event payloads.
- Config changes must keep `oa validate` passing on `docs/examples/*.yaml` and
  `docs/examples/connectors.d/*.yaml`.
- Model IDs: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`. Use adaptive thinking
  and `output_config.effort` on Sonnet/Opus 5; Haiku 4.5 has no effort parameter. No
  assistant prefill (rejected on current models). Don't append date suffixes to IDs.
  Other providers' ids are used verbatim and need a `pricing:` entry unless the built-in
  table knows them (current OpenAI models, `typesafe/jev-1.13`) or the provider reports
  cost (OpenRouter); a model without a price fails `oa validate`. `decide` defaults to
  `typesafe/jev-1.13`, which is classification-only and lives behind the Decisions API,
  never Chat Completions.

## Commands

```
npm install
npm run build          # tsc -b across workspaces
npm test               # vitest
npm run lint           # eslint + prettier check
node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml
node packages/core/dist/main.js --config docs/examples/agent.yaml   # the daemon
node packages/cli/dist/main.js run <task> --wait --socket <path>       # or OA_CORE_SOCKET
node packages/cli/dist/main.js emit <type> [payload.json|-]
node packages/cli/dist/main.js connector list|restart <name>            # restart re-resolves secrets
node packages/cli/dist/main.js cost [--by task|model|provider|day] [--since 7d]
```

(Keep this list in sync with `package.json`.)

## Conventions

- Small modules, one action runner per file under `packages/core/src/actions/`.
- Tests next to code as `*.test.ts`; integration tests use a temp SQLite file and fake
  connectors (`packages/core/test/fixtures/`), never the network or a real model.
- Templates: `${…}` is JMESPath over `{event, result, state, secrets, env, run, item,
  steps}`; a whole-string template yields the raw value. `secrets` are allowed in actions
  only, as `secrets.<name>`.
- Log lines are structured JSON with `run_id`, `task`, `correlation_id`.
- When the architecture and the code disagree, fix one of them in the same change and say
  which.
