# Webhook connector

Generic HTTP in: a small server that answers the configured routes, verifies each request
(GitHub, Slack or Stripe signature, GitLab token, HMAC with an optional timestamp
window, bearer token, or nothing) and emits it as one event.
Emit-only (`transport: none`), no ops. How to deploy it behind a reverse proxy, configure
routes and use the events: [`docs/connectors/webhook.md`](../../docs/connectors/webhook.md).
Example manifest: [`docs/examples/connectors.d/webhook.yaml`](../../docs/examples/connectors.d/webhook.yaml).

## Development

```
connectors/webhook/src/
  config.ts   zod schema: listener (TCP or Unix socket), routes, verify kinds and their defaults, route name slugs;
              startupWarnings: one line per route with verify: none, and one per route without
              dedup_header (sender retries then create duplicate events)
  verify.ts   token and HMAC checks, constant-time: checkHeaders settles what the headers can
              (token, signature format, timestamp window) before the body is read;
              verifyRequest runs the HMAC over the raw body (with the timestamp layout)
  server.ts   routing, the early header check (401 with Connection: close, body unread),
              max_connections, body limit and parsing, the event payload, status codes (202/200/400/401/404/405/413/422/503/500)
  main.ts     connectorEnv + CoreClient; listens, logs the routes and the startup warnings; on SIGTERM and SIGINT drains requests in flight for 4 s, then exits
```

Tests run without the network beyond loopback: `server.test.ts` starts the server on a
random port (and on a Unix socket) against an in-memory core that honours `dedup_key`.
The smoke rig sends real signed requests, including GitHub's documented test vector, to a
TCP listener and a Unix socket, and needs no server of its own:

```
npm run smoke:connectors -- webhook    # test/smoke/smoke.mjs
```

To try it by hand against a running daemon, put the manifest in `agent.yaml` and:

```
body='{"ref":"refs/heads/main"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -i localhost:8787/hooks/github -H 'content-type: application/json' \
  -H 'X-GitHub-Event: push' -H 'X-GitHub-Delivery: test-1' \
  -H "X-Hub-Signature-256: sha256=$sig" -d "$body"
oa events tail --type github.push
```

`examples/github-deploy.yaml` is a complete deploy-on-push workflow.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/webhook.yaml connectors/webhook/examples/github-deploy.yaml
```
