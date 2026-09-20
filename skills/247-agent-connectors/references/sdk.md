# `@247-agent/connector-sdk`

`packages/connector-sdk/src/index.ts`. No local imports, so Node can run a connector
straight from `.ts` source (used by the test fixtures).

## All-in-one

```ts
import { z } from 'zod';
import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    // optional: start a poller, a bot, an HTTP listener. rt.env.config is the manifest's config.
  },
  tools: (rt) => [
    defineTool({
      name: 'fetch_new',
      description: 'New messages since a UID',
      input: { folder: z.string().optional(), since_uid: z.number().nullable().optional() },
      handler: async (args) => {
        const cursor = (await rt.core.getState('last_uid')) ?? 0;   // own namespace
        // ...
        await rt.core.putState('last_uid', 42);
        return { emails: [] as JsonValue[], last_uid: 42 };        // must be JSON
      },
    }),
  ],
});
```

`runConnector` reads the environment, builds a `CoreClient`, registers the tools on an
MCP server and serves it on stdio. `setup` runs first. Throwing inside a handler
becomes an `isError` result.

## Pieces

| export | purpose |
|---|---|
| `connectorEnv()` | `{socket, name, config}` from `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME`, `OA_CONFIG_JSON`; throws when not started by the core |
| `CoreClient({socket, name, timeoutMs?})` | `emitEvent({type, payload?, dedup_key?, parent_id?, correlation_id?})` → `{status: 'inserted', event}` or `{status: 'duplicate', dedup_key}`; `getState(key)`, `putState(key, value)` in the connector's own namespace |
| `defineTool({name, description?, input?, handler})` | `input` is a zod raw shape; the handler is typed from it |
| `createConnectorServer({name, version?, tools})` | an `McpServer` with the tools registered; results are one JSON text block |
| `serveStdio(server)` | connect on stdin/stdout |
| `ConnectorRuntime` | `{env, core, log}`; `log(line)` writes to stderr |
| `CoreApiError` | thrown by `CoreClient` on non-2xx, with `.status` |

## Push-style emitting

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

For replies to an `ask`, include the stored `correlation_id` on the event and in the
payload (see `packages/core/test/fixtures/fake-chat.ts`).

## Packaging a real connector

One npm workspace per connector under `connectors/<name>/` with its own
`package.json`, `dist/main.js` as the manifest's `exec` target, and the SDK as a
dependency. Keep network clients (imapflow, nodemailer, grammy, …) inside the connector;
the core never depends on them. Add a fake next to it for the core's integration tests.
