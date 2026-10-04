# Testing

The ladder from a unit test to a real agent on a real server, and how to climb it.
Open this when writing or changing a test, a fixture or a smoke rig, and before
reporting any change: the `verify` skill (`.claude/skills/verify/`) picks the rungs a
diff needs from this ladder.

## Rungs

| Rung | Command | Proves |
|---|---|---|
| baseline | `npm run build && npm run lint && npm test && node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml && node scripts/check-docs.mjs` | types, style, unit and integration tests on fakes, the examples, the docs |
| daemon | a scratch daemon, `oa run`, `oa emit`, `oa runs show`, `oa runs logs` | the change on the real binary: wiring, API, CLI output, reload |
| linux | `npm run test:linux` | the suite on Debian 13 with real bubblewrap (`OA_REQUIRE_BWRAP=1` fails the bwrap tests instead of skipping them) |
| linux-systemd | `npm run test:linux -- --systemd=always` | also the release tree, the `.deb`, the unit, `oa run hello --wait`, purge |
| connectors | `npm run smoke:connectors [-- <name>…]` | chat, email, ftp and webhook against real servers in podman |
| acp | `npm run smoke:acp -- <agent>` | the `agent` action on a real agent program |
| ci | push the branch | the workflow itself, or Linux when no container engine works |

Every rig ends with one line, `RESULT: PASS|FAIL|ERROR …`, and shares the exit codes
in `test/smoke/lib.mjs`: 0 passed, 1 a check failed, 2 the rig could not start, 3 the
environment (no engine, or every failure was a provider outage), 130 interrupted. A
check that throws is a FAIL, never a 2.

## Unit and integration tests

Vitest, `*.test.ts` next to the code, in `packages/**` and `connectors/**`. They never
touch the network or a real model: connector tests inject a fake `fetch` or a fake
server library, adapter tests drive the real SDK through `recordingFetch()` from
`packages/core/src/llm/testing.ts`, and runner tests use `fakeLlmPort` and
`fakeProviderFactory()` from the same place. Tests in other packages reach the core's
sources, not its `dist/` (`vitest.config.js`).

Integration tests (`packages/core/src/integration.test.ts`,
`integration.agent.test.ts`, `core.*.test.ts`, `daemon.test.ts`) start a real daemon on
a temp SQLite file with the fixtures below and drive it through the API: the non-model
path of the website workflow, reload, retention, recovery, the agent runner against the
fake ACP agent. A new integration test follows `integration.test.ts`.

## Fixtures

`packages/core/test/fixtures/` holds programs Node runs straight from TypeScript
source, so a manifest can say `exec: [node, packages/core/test/fixtures/fake-email.ts]`:

| Fixture | What it fakes |
|---|---|
| `fake-email.ts` | the email connector: `fetch_new` from `config.mails`, `mark_read` |
| `fake-ftp.ts` | the ftp connector: the seven ops over an in-memory tree from `config.files` |
| `fake-chat.ts` | the chat connector: `send` records to state, `ask` answers itself after `delay_ms` with a `chat.reply` |
| `fake-mcp.ts` | a generic MCP server with scripted tools |
| `fake-plain.ts` | a connector that only emits |
| `fake-acp.ts` | an ACP agent scripted by markers in the prompt (`[[run: …]]`, `[[edit: …]]`, `[[result: {…}]]`, `[[cost: …]]`, `[[tools: N]]`, `[[slow: ms]]`, `[[refuse]]`, `[[crash]]`, `[[mcp: …]]` and more; read the file) |
| `fake-bwrap.ts` | a stand-in `bwrap` that records its argv, for sandbox tests on macOS |

A fake keeps the real connector's op and event shapes, so a task file tried against
fakes runs unchanged against the real thing. Add a fake next to a new connector
(`howto/add-connector.md`).

## Linux in a container

`scripts/linux-test.sh [--systemd=never|always] [--keep]` lints on the host, then copies
the working tree (tracked and untracked, minus `.gitignore`) into a privileged Debian 13
container with the `.node-version` Node and bubblewrap, and runs `npm ci`, build, test
with `OA_REQUIRE_BWRAP=1` and validate. `--systemd=always` boots systemd in the
container and repeats CI's last steps: the release tree, the `.deb`, install, unit
active, `oa run hello --wait`, purge. Downloads are cached in a volume; `--keep` leaves
the container to look inside. On Apple Silicon it tests linux-arm64. Exit 3 is the
environment (no engine, image or container could not be set up); the usual suspects are
`podman machine start` and disk space.

## The connector smoke rig

`test/smoke/connectors/run.mjs` (`npm run smoke:connectors [-- <name>…] [--keep]`)
starts, per connector, the servers in `connectors/<name>/test/smoke/compose.yaml`
with `podman compose`, waits for their ports, lets the connector's `smoke.mjs` provision
users and rooms, writes a daemon config on the real connector programs, starts the
daemon, calls every op through `oa run` and reads every event back, restarts a
connector, then scans every run record and every file the daemon wrote (the database
with its WAL, the log, the sync trees) for the servers' passwords and tokens. Chat is
Matrix on Synapse (Telegram has no server to run); email is GreenMail with Dovecot as
a STARTTLS proxy; ftp is atmoz/sftp built at a pinned commit, vsftpd FTP and vsftpd
FTPS; webhook needs no server. GitHub and Jira have no rig: their services cannot run
in a container, so their ops are covered by unit tests against a fake API. One run per
host (a lock in `$TMPDIR`); a killed run's daemon and servers are cleaned up by the
next run. `test/smoke/connectors/README.md` describes each module's checks and the
`rig` API a module uses.

## The ACP smoke rig

`test/smoke/acp/run.mjs` (`npm run smoke:acp -- claude-acp|codex-acp|opencode-acp`)
runs the `agent` action against one pinned real agent program on the user's login (no
API key reaches the agent): four tasks check `done` with gates and a commit, `blocked`
with `missing`, an `mcp_servers` call through the bridge, and `model`/`effort`
overrides in the `agent.config` log line; then a canary secret is sent through a prompt
and the whole database and log are scanned for it and for anything shaped like a key.
Budgets are capped at $0.50 per run and $3 per day of notional ledger cost across the
day's runs. `opencode-acp` is free and needs no login but is flaky; `claude-acp` is what
production uses and the reliable signal; `codex-acp` needs `~/.codex/auth.json`.
`test/smoke/acp/README.md` lists the profiles, the checks and the quirks the rig has
found.

## Docs

`node scripts/check-docs.mjs` checks every relative link and every `yaml` block in the
repository's Markdown, and runs `oa validate` on blocks that are whole tasks files or
manifests (`writing.md`). Prettier skips Markdown and `docs/`, so lint proves nothing
about them; for a docs change, also run the commands the page states when they are
cheap.

## Reporting

End every report with one line per rung the plan listed: the command, the `RESULT`
line, and for a rung not run, why. "Not verified" is allowed only for the gaps
`plan.mjs` prints, such as the `llm` adapters against a live key, for which no rig
exists.
