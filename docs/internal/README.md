# Internal documentation

For people and agents changing 247-agent. The user-facing documentation is one level
up, starting at [`../index.md`](../index.md); this tree holds the design, the contracts
each module keeps, and the procedures. `CLAUDE.md` at the repository root is the index
agents load on every turn; this file is the human one.

| File | Open it when |
|---|---|
| [`architecture.md`](architecture.md) | you touch the dispatch loop, the run lifecycle, durability, or need the module map |
| [`decisions.md`](decisions.md) | you want to know why something is built this way, or propose a dependency or a structural change |
| [`actions.md`](actions.md) | you touch `shell`, `connector`, `wait`, `sequence`, `emit`, `state_updates` or templating |
| [`model-actions.md`](model-actions.md) | you touch the `ctx.llm` port, an adapter, pricing, budgets, batches or `decide` |
| [`agent-action.md`](agent-action.md) | you touch the agent runner, the ACP client, the permission policy, the tool bridge, workspaces or transcripts |
| [`connectors.md`](connectors.md) | you touch the supervisor, the connector protocol, the SDK, the poller, `managed_by: systemd`, or a bundled connector |
| [`config.md`](config.md) | you touch the config schemas, loading, `oa validate` cross-checks or reload |
| [`store.md`](store.md) | you touch a table, a migration or retention |
| [`security.md`](security.md) | you touch sandboxing, secrets or anything on the trust boundary |
| [`packaging.md`](packaging.md) | you touch `bin/`, `scripts/`, `packaging/`, `.github/` or the version |
| [`testing.md`](testing.md) | you write a test, a fixture or a smoke rig, or need to know which rung proves what |
| [`writing.md`](writing.md) | you write or change documentation, a connector README, a skill or `CLAUDE.md` |
| [`howto/add-connector.md`](howto/add-connector.md) | adding a bundled connector |
| [`howto/add-action.md`](howto/add-action.md) | adding an action kind |
| [`howto/add-provider.md`](howto/add-provider.md) | adding a model provider adapter |
| [`howto/add-metric.md`](howto/add-metric.md) | adding a metric |
| [`howto/release.md`](howto/release.md) | cutting a release |

## Where things live

```
bin/                       launchers (247-agent-core, oa, 247-agent-connector-host, 247-agent-connector-<name>); the same files in a checkout and a release
scripts/                   bundle.mjs, build-release.sh, build-package.sh, install.sh, uninstall.sh, linux-test.sh, check-docs.mjs
packaging/                 the two units, etc/ (starter config), nfpm.yaml + scripts/ (maintainer scripts)
packages/core/src/         the daemon
  config/                  zod schemas (agent.ts, schema.ts, connector.ts, retention.ts), loader, validators, cross-checks
  store/                   better-sqlite3: events, runs, waits, state, ledger, transcripts, llm_batches; migrations; retention SQL
  bus/                     publish, matcher, dispatch loop, manual runs
  scheduler/               croner jobs → cron.tick events
  executor/                worker pool: concurrency, timeouts, retries, secrets, emit and state routing, wait suspend and resume, recovery
  actions/                 one runner per kind; agent-*.ts (policy, workspace, result, session config, transcript); sandbox.ts, sandbox-net.ts
  llm/                     the ctx.llm port (service.ts), pricing, batches, one adapter per provider type
  connectors/              supervisor, acp client, mcp-bridge, net-proxy, poller, host + socket-transport (managed_by: systemd), child-env
  secrets/                 env, file, systemd-credentials backends
  api/                     routes (transport-free), server (node:http on the socket), client (for the CLI and TS connectors)
  expr/                    type globs, JMESPath filters, ${…} templating
  core.ts, daemon.ts, main.ts, host-main.ts, home.ts, metrics.ts, retention.ts, log.ts, ids.ts, clock.ts, version.ts
packages/core/test/fixtures/   fake connectors, a fake ACP agent, a fake bwrap
packages/cli/src/          oa: one file per command under commands/
packages/connector-sdk/src/index.ts   runConnector, defineTool, CoreClient; no local imports
connectors/<name>/         one workspace package per bundled connector: src/, README.md (development notes), examples/, test/smoke/
test/smoke/                lib.mjs (exit codes, RESULT line, lock), connectors/ and acp/ rigs
skills/                    agent skills that ship with releases; .claude/skills/ links to them
docs/                      the user site; examples/ (validated in CI, shipped); internal/ (this tree)
```
