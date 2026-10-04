# Writing your own connector

A connector is any executable with a manifest. The daemon starts it, hands it its
configuration in the environment, and talks to it over two HTTP calls and one protocol.
This page shows the three shapes a connector takes, the rules every one follows, the
TypeScript SDK, and how to do the same in any other language.

## Pick the shape

- **Poll-style** (a mailbox, an API with a cursor): expose a `fetch_new`-like op that
  takes a cursor and returns `{ items, cursor }`. A cron task calls it and fans the items
  out with `emit … each` and a `dedup_key`; the connector itself emits nothing. This keeps
  polling, dedup and routing in the daemon, where you can see them.
- **List-style** (an op that returns what exists now): no connector code at all. The
  built-in [poller](poller.md) calls the op on a schedule and emits one event per new
  item.
- **Push-style** (a chat bot, a webhook receiver): emit events from the process as they
  arrive, each with a `dedup_key` (a message id) and, for the answer to a question, the
  `correlation_id` the asking task passed in.
- **Ops-only** (send mail, post a message, write a file): just tools.

## The rules

These hold in every language, and the daemon relies on them:

- **Read configuration from `OA_CONFIG_JSON`**, never from files. Secrets are already
  rendered into it. Read it once at start and delete it from your environment, so a
  program you spawn does not inherit the secrets.
- **Keep state in the daemon**, not on disk: a cursor, a last-seen id, open questions.
  `GET` and `PUT /v1/state/<your name>/<key>` on the daemon's socket. Expect to be
  restarted at any time.
- **Log to standard error.** The daemon records it as `connector.output`. With
  `transport: stdio`, standard output is the protocol channel and a stray print breaks it.
- **Return JSON-serialisable results** from ops. Throw, or return an MCP error, to signal
  an op failure; the calling run fails without retry, on purpose.
- **Exit non-zero on an unrecoverable error** (a bad token, a port in use). The daemon
  restarts you with backoff and shows the error in `oa connector list`.
- **Name events `<connector>.<what happened>`**, lower-case dotted segments:
  `chat.reply`, `email.received`.

## In TypeScript, with the SDK

`@247-agent/connector-sdk` does the boilerplate: it reads the environment, builds a client
for the daemon, registers your tools on an MCP server and serves it on standard output.

```ts
import { z } from 'zod';
import { defineTool, runConnector } from '@247-agent/connector-sdk';

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    // optional: start a poller, a bot or an HTTP listener here.
    // rt.env.config is the manifest's config, secrets filled in.
  },
  tools: (rt) => [
    defineTool({
      name: 'fetch_new',
      description: 'New messages since a cursor',
      input: { since: z.number().nullable().optional() },
      handler: async (args) => {
        const cursor = (await rt.core.getState('cursor')) ?? 0;   // your own namespace
        // ... fetch what is newer than the cursor ...
        await rt.core.putState('cursor', 42);
        return { items: [], cursor: 42 };                          // must be JSON
      },
    }),
  ],
});
```

`runConnector` reads the environment (and fails if the daemon did not start you), builds
the runtime, runs `setup`, registers the tools and serves. A thrown error inside a
handler becomes an op error for the calling task; a thrown error in `setup` ends the
process with exit code 1. The handler's `args` are typed and validated from `input`, a
zod shape.

| Export | What it does |
|---|---|
| `runConnector({ version?, setup?, tools })` | all of the below in one call; returns the runtime |
| `connectorEnv()` | `{ socket, name, config }` from the environment; deletes `OA_CONFIG_JSON` once read |
| `CoreClient({ socket, name })` | `emitEvent({ type, payload?, dedup_key?, parent_id?, correlation_id? })`, `getState(key)`, `putState(key, value)`, all in your own namespace |
| `defineTool({ name, description?, input?, handler })` | one op; `input` is a zod shape and the handler is typed from it |
| `createConnectorServer({ name, version?, tools })` | the MCP server with the tools registered |
| `serveStdio(server)` | connect it to standard input and output |
| `ConnectorRuntime` | `{ env, core, log }`; `log(line)` writes to standard error |
| `CoreApiError` | thrown by the client on a non-2xx answer, with `.status` |

A push-style connector emits from `setup`:

```ts
setup: (rt) => {
  bot.on('message', async (m) => {
    await rt.core.emitEvent({
      type: 'chat.message',
      dedup_key: `chat:${m.id}`,
      payload: { text: m.text, from: m.from },
    });
  });
},
```

For the answer to a question, include the stored `correlation_id` both on the event and
in its payload; the waiting task matches on `payload.correlation_id`.

The SDK has no local imports, so Node runs a connector straight from TypeScript source:
a manifest may say `exec: [node, path/to/connector.ts]`, which is how the daemon's own
tests run fake connectors.

## In any other language

Two HTTP calls over the daemon's Unix socket, and MCP over standard input and output for
ops.

**Emit an event:**

```sh
curl --unix-socket "$OA_CORE_SOCKET" -X POST http://unix/v1/events \
  -H 'content-type: application/json' \
  -d '{"type":"webhook.received","source":"'"$OA_CONNECTOR_NAME"'","payload":{"repo":"x"},"dedup_key":"webhook:abc"}'
```

`201` means inserted, `200` a duplicate of the `dedup_key` that was dropped, `400`
invalid. The daemon assigns the id and timestamp. Optional fields: `dedup_key`,
`correlation_id` (to thread under an existing happening), `parent_id` (inherits the
parent's correlation id).

**Read and write your state:**

```sh
curl --unix-socket "$OA_CORE_SOCKET" http://unix/v1/state/$OA_CONNECTOR_NAME/cursor
curl --unix-socket "$OA_CORE_SOCKET" -X PUT http://unix/v1/state/$OA_CONNECTOR_NAME/cursor \
  -H 'content-type: application/json' -d '{"value": 42}'
```

A missing key answers `404`. Tasks can read the same value as
`${state.<your name>.cursor}`.

**Expose ops:** speak MCP over standard input and output: JSON-RPC, tools listed by
`tools/list` and called by `tools/call`. Return the result as `structuredContent`, or as
one text block containing JSON, which the daemon parses. Signal a failure with
`isError: true` and a message. Any MCP SDK works (Python, Go, …), and any existing MCP
server is a connector unchanged.

## Using an existing MCP server

Point `exec` at it and give it its configuration through `env`:

```yaml
name: files
exec: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/exchange"]
transport: stdio
ops: []                                 # list what it serves, then pin the ones you use
```

Its tools return their own shapes, so run an op once with `oa run` before writing a
poller's `items` or a task's templates against it. Then replace `ops: []` with the exact
list your tasks use: the list is a security boundary, and an agent handed this connector
can call only what it names.

## Running one by hand

Start it with the three variables the daemon would set, and read its standard error:

```sh
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=mine \
OA_CONFIG_JSON='{"host":"example.com"}' \
node dist/main.js
```

Then type MCP JSON-RPC on standard input (`initialize`, then `tools/call` with your op
and arguments), or point a scratch `agent.yaml` at the manifest and use
`oa run <task> --wait` on a task that calls the op. The common failures and their causes:

| Symptom | Cause and fix |
|---|---|
| the run fails with `op … not allowed` | the op is not in the manifest's `ops`; add it, or use `ops: []` |
| the run fails with your error text and no retry | the handler threw; fix the handler, the run is not retried on purpose |
| the run fails with `connector … is down` and retries | the process is not up: read its `connector.output` lines, look for a crash loop with a growing backoff |
| the connector restarts every few seconds | it exits at start; run it by hand as above and read standard error |
| MCP handshake errors | something wrote to standard output; route all logging to standard error |
| events never arrive | check the `POST /v1/events` answer: `200` is a duplicate; check the type matches the trigger and its filter |
| a secret is empty in the config | `${secrets.x}` in the manifest, but the backend has no `x` |

## Testing with fakes

Write a fake next to the real connector that serves the same op and event shapes from
data in its `config`, and point a scratch manifest at it. A task file tried against the
fake runs unchanged against the real thing, and a whole workflow can be exercised with no
network and no model. The daemon's own test fixtures do this for every bundled connector.
