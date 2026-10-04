# 247-agent

A 24/7, config-driven automation daemon for a single Linux server. Tasks are declared in
YAML, each a trigger (cron, event, manual) plus one action (`shell`, `connector`, `wait`,
`sequence`, `llm`, `decide`, `agent`) plus `emit` routing; everything between tasks is an
event; connectors are sub-programs (MCP servers for ops, ACP agents for `agent`
actions); SQLite holds events, runs, state and the cost ledger. TypeScript on Node.js 22,
npm workspaces, strict ESM.

## Read before you change

The internal docs under `docs/internal/` are the source of truth for design and
contracts. Open the one for what you touch; `docs/internal/README.md` is the index.

| Touching | Read first |
|---|---|
| anything structural: dispatch, run lifecycle, durability, the module map | `docs/internal/architecture.md` |
| why a dependency, protocol or design was chosen, or proposing another | `docs/internal/decisions.md` |
| `packages/core/src/actions/{shell,connector,wait,sequence}.ts`, `expr/`, `emit`, templating | `docs/internal/actions.md` |
| `packages/core/src/llm/`, `actions/llm.ts`, `actions/decide.ts`, pricing, budgets, batches | `docs/internal/model-actions.md` |
| `packages/core/src/actions/agent*.ts`, `connectors/acp*.ts`, `connectors/mcp-bridge.ts` | `docs/internal/agent-action.md` |
| `packages/core/src/connectors/`, `packages/connector-sdk/`, `connectors/<name>/`, a manifest | `docs/internal/connectors.md` |
| `packages/core/src/config/`, reload, `oa validate` cross-checks | `docs/internal/config.md` |
| `packages/core/src/store/`, migrations, retention | `docs/internal/store.md` |
| sandboxing, secrets, the trust boundary | `docs/internal/security.md` |
| `bin/`, `scripts/`, `packaging/`, `.github/`, the version | `docs/internal/packaging.md` |
| a test, a fixture, a smoke rig | `docs/internal/testing.md` |
| `docs/`, a connector `README.md`, a skill, this file | `docs/internal/writing.md` |
| adding a connector, an action kind, a provider adapter or a metric; cutting a release | `docs/internal/howto/` |

`docs/examples/website-updates.yaml` is the reference workflow; keep it valid.

## Rules

- Everything goes through events. Tasks reference event types, never other tasks. Do
  not add direct task-to-task calls.
- No LLM in the core's control flow. Matching, dedup, routing, retries, publishing are
  code. A model call happens only inside an `llm`, `decide` or `agent` action.
- Every model call goes through the `ctx.llm` port, records usage in the ledger and
  respects the task's `budget` and the global daily cap. Never add an unbudgeted call.
- Agents run in a fresh workspace (git worktree or temp dir) with an explicit tool-kind
  and command allowlist enforced through ACP permission requests, produce a
  `RESULT.json` with `status: done | blocked` and `summary`, and pass deterministic
  `post` gates only when `done`; `blocked` still succeeds so `emit` can route it. Agents
  never hold deploy secrets and never publish. Only `acp` connectors may be sandboxed
  (`sandbox: bwrap` on the manifest); `sandbox.network.allow` leaves the program no
  network but the core's filtering proxy.
- Secrets are resolved by name from the configured backend at run time. Never write
  them to the DB, run logs, event payloads or transcripts.
- Config changes keep `oa validate` passing on `docs/examples/*.yaml` and
  `docs/examples/connectors.d/*.yaml`.
- Anything worth graphing is a metric on the shared `Metrics` registry
  (`packages/core/src/metrics.ts`): counters where the thing happens, gauges from a
  `collect` callback in `core.ts`. Labels stay bounded (task, connector, model), never
  ids.
- Settings from `agent.yaml` survive a reload: a component reads them through a
  `configure()` seam, never a constructor-only copy. Only `db`, `socket` and `secrets`
  are fixed for the process.
- Manifests name the bundled connectors by launcher (`exec: ["247-agent-connector-email"]`),
  never by a `dist/` path. A new bundled connector needs a launcher in `bin/` and an
  entry in `scripts/bundle.mjs`.
- The version lives in `packages/core/src/version.ts` and the root `package.json`
  (a test keeps them equal); release tags are `v<version>`.
- Model IDs: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`. Adaptive thinking
  and `output_config.effort` on Sonnet/Opus 5; Haiku 4.5 has no effort parameter. No
  assistant prefill. No date suffixes. Other providers' ids verbatim; a model without a
  price fails `oa validate` unless the provider reports cost. `decide` defaults to
  `typesafe/jev-1.13`, classification-only, served by OpenRouter's Decisions API, never
  Chat Completions.

## Commands

```
npm install && npm run build       # tsc -b across workspaces
npm test                           # vitest; never the network or a real model
npm run lint                       # eslint + prettier (prettier skips Markdown and docs/)
node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml
node scripts/check-docs.mjs        # links and YAML blocks in every Markdown file
npm run test:linux                 # the suite on Debian 13 with bwrap in a container; --systemd=always adds the .deb
npm run smoke:connectors [-- <name>…]   # real servers in podman
npm run smoke:acp -- <agent>       # claude-acp | codex-acp | opencode-acp
node packages/core/dist/main.js --config <agent.yaml>    # the daemon; bin/247-agent-core is the same
node packages/cli/dist/main.js …   # oa; bin/oa is the same; docs/reference/cli.md lists the commands
```

## Conventions

- Before reporting a change done, prove it with the `verify` skill: run the rungs its
  `scripts/plan.mjs` lists for the diff and end the report with what each showed.
  Never ask the user to check something a rung can observe.
- Small modules, one action runner per file under `packages/core/src/actions/`.
- Tests next to code as `*.test.ts`; integration tests use a temp SQLite file and the
  fakes in `packages/core/test/fixtures/`, never the network or a real model.
- Templates: `${…}` is JMESPath over `{event, result, state, secrets, env, run, item,
  steps}`; a whole-string template yields the raw value. `secrets` only in actions, as
  `secrets.<name>`.
- Log lines are structured JSON with `run_id`, `task`, `correlation_id`.
- When a doc and the code disagree, fix one of them in the same change and say which.
  Docs follow `docs/internal/writing.md`; the user site never mentions status or plans.
