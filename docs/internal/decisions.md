# Decisions

Why the daemon is built the way it is. Open this before proposing a dependency, a
protocol or a structural change, so the proposal argues against the reason and not
against the result. Each entry is the decision, the reason, and what it commits us to.

## A small core instead of a workflow engine

Candidates and verdicts:

| Candidate | Verdict |
|---|---|
| n8n, Node-RED, Windmill, Huginn | The trigger→action model fits, but they are UI-first, workflows are opaque JSON, and "an agent edits a checkout and runs a build" is awkward. A heavy runtime for one server. |
| Temporal, Airflow, Prefect | Durable orchestration, but workflows are code or batch DAGs. Not config-driven. |
| systemd timers plus scripts | Fine for cron. No event chaining, no state, no model budgets. |
| Anthropic Managed Agents | A fine host for the `agent` tier, rejected as the core: the deploy target, credentials and checkout live on the user's server, and cost control wants local gating. A hosted agent that speaks ACP plugs in as one more `transport: acp` connector. |

Commitment: the core stays small and reuses aggressively underneath: systemd for
supervision, SQLite for every table, MCP for connector operations, ACP for agent loops,
and one library each for cron (`croner`), schemas (`zod`), expressions (`jmespath`),
SQLite (`better-sqlite3`), YAML (`yaml`) and subprocesses (`execa`).

## TypeScript on Node.js 22

The Anthropic SDK, the MCP reference SDK and the ACP SDK are TypeScript, and the agent
programs are mostly Node programs. One runtime serves the core, the agents and most
connectors. Connectors and agents stay language-agnostic through the protocol
(`connectors.md`). The release vendors a pinned Node so the server needs nothing.

## One process, one SQLite file, in-process dispatch

Events, runs, state, the ledger, transcripts and batch bookkeeping are tables in one
WAL-mode database. `better-sqlite3` is synchronous: every store operation is a short
transaction on the main thread, which removes a class of async bugs and is fine at the
scale of one server. Actions are I/O-bound (subprocesses, HTTP), so worker threads add
nothing. If a queue is ever needed, the dispatch loop in `packages/core/src/bus/` is the
only seam to replace.

## Everything is an event; tasks never name tasks

A task triggers on event types, including the automatic `task.<name>.succeeded|failed`
events, never on another task. That decoupling is what lets a workflow grow by adding
a listener. Two guards make it safe: a task never matches events from its own runs,
and `limits.max_event_depth` drops runaway chains. "Just let A call B" proposals are
refused on this ground.

## No model in the control flow

Matching, dedup, routing, retries and publishing are code. A model runs only inside
`llm`, `decide` and `agent` actions, through one port (`ctx.llm`) that prices, budgets
and ledgers every call. Prices come from a table or from the provider's own report,
never from a guess; an unpriced response fails the run so it is noticed. An `agent`
turn is ledgered from what the ACP agent reports, under the connector's name. The
reason is cost predictability: a user can read `oa cost` and the budgets and know the
worst case.

## MCP for connector operations

A connector's operations are MCP tools over stdio. Existing MCP servers become
connectors as-is, the core is one MCP client, and the same tools can be handed to an
agent session through the core's bridge (`agent-action.md`), with the manifest's `ops`
allowlist applying underneath. The alternative, a bespoke RPC, would have cost every
connector author a client library.

## ACP for agent loops

An `agent` action opens a session on any program that speaks the Agent Client Protocol
(claude-agent-acp, codex-acp, opencode, gemini). The loop, file edits, shell, per-call
permission requests, cancellation and usage reporting are the protocol's; swapping the
agent is a manifest change. The agent runs the model with its own key, so the core never
holds a model key for agents and never talks to a provider on their behalf.
Consequences: `mode` is not exposed (a permissive mode would bypass the permission
policy the core relies on); model and effort are set through ACP config options found
by category, since agents name them differently.

## The permission policy is judged per call, and after the fact

Every permission request is answered against `tools` and `bash_allow`, never with
`allow_always`. Agents also act without asking (Claude Code for reads and read-only
commands, Codex for everything its own sandbox admits), so every reported tool call is
judged after the fact and a violation cancels the session. `unasked_execute: sandboxed`
exists only because Codex's OS sandbox is a stronger guarantee than a string match on
commands it never asks about. The check catches a step outside the policy; it does not
prevent it, which is why the program is also sandboxed.

## The sandbox is per program, not per run, and keeps the daemon's uid

The trust boundary is the daemon's uid: any process running as `247-agent` can reach
the socket and read the others' environments. The one process that executes untrusted
content, the agent program, is confined with bubblewrap: its own pid namespace, the
daemon's config, database and socket directories masked, `work_dir` the only writable
path. A second uid would add nothing the daemon can enforce without privileges. The
sandbox wraps the long-lived process once, so concurrent runs share it and an agent can
see other runs' workspaces, as it already could in one process. Only `acp` manifests
accept `sandbox`: every other connector needs the core socket the sandbox hides.

## A network allowlist through a filtering proxy

bwrap can only share the host's network or cut it off. An allowlist is built from an
empty network namespace, a proxy the core serves on a Unix socket beside the core
socket, and a small bridge inside the sandbox that exposes the proxy on loopback and
sets `HTTP_PROXY`/`HTTPS_PROXY`. The proxy judges host and port and never reads a
tunnel: it limits where the agent talks, not what it says. Wildcards never resolve to
loopback, private or link-local addresses, so a name under an allowed suffix cannot
point the agent at the host's own services.

## `decide` only through OpenRouter's Decisions API

TypeSafe's Jev is a classification-only model behind a different protocol from Chat
Completions. OpenRouter serves it with the same key and the same per-response cost as
every other model there, so the adapter is a plain `fetch` in the OpenRouter adapter
and the cross-check refuses any other provider type. A direct `typesafe` provider type
is possible later; the wire shape is the same.

## One batch per run

`batch: true` submits one Message Batches request per run and parks the run on
`llm.batch.ended`, so bookkeeping stays per run and the poller's work is one retrieve
per batch. The known gap: the Batches API has no idempotency key, so a daemon killed
between Anthropic accepting a batch and the row being written loses track of it and the
retry submits again. Accepted; the window is milliseconds.

## Connector secrets in the environment, scoped by manifest

A connector receives, once at spawn, only the secrets its manifest names, rendered into
`OA_CONFIG_JSON`, which the SDK deletes from the environment after reading so children
do not inherit it. There is no secrets endpoint on the API and none should be added: a
pull endpoint would hand every local process every secret. A connector that must hold a
secret the daemon should not see, or needs privileges, runs in its own unit
(`managed_by: systemd`), where its own `LoadCredential=` lines live and the daemon never
resolves them.

## Prompt caching by construction

`system_file` is static, rendered first and sent with a cache marker; the event data is
last. The ledger reports cache reads per task so a silently invalidated cache is
visible. Before building a cascade of models, measure the stronger model at low effort:
on the current generation it often wins, and one model is one cache namespace.

## Chat: Telegram first, Matrix unencrypted

Telegram is the least friction for a single user. Matrix is for people who self-host;
the connector speaks the plain Client-Server API, so rooms must be unencrypted.
End-to-end encryption would need a crypto store (libolm or vodozemac) in the connector,
which is not worth it until someone needs it.

## JMESPath for expressions

Simple, ubiquitous, one function to swap for CEL if typed expressions are ever needed.
The matcher and the template renderer are the only two places that evaluate it.

## A relocatable release tree, the same launchers in a checkout

The daemon finds its install root (`OA_HOME`, else the nearest ancestor of its script
with `bin/247-agent-core`) and puts `<root>/bin` and its own Node first on `PATH` for
every child. That is why manifests name bundled connectors by launcher and work
unchanged in development, in `/opt/247-agent` and in a package install.
