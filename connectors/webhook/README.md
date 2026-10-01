# Webhook connector

Generic HTTP in. A push-style, emit-only connector (`transport: none`): a small HTTP server
that answers the paths listed in `routes`, checks each request (a GitHub signature, an
HMAC, a shared token) and emits it as one event. It serves no ops. Senders get a status
they can act on: `202` emitted, `200` a redelivery that was dropped, `4xx` never retry,
`503` the daemon is unreachable, retry later.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/webhook.yaml
```

## Manifest

```yaml
name: webhook
exec: ["247-agent-connector-webhook"]
transport: none
emits: [github.push, github.pull_request, deploy.requested]
config:
  listen: { host: 127.0.0.1, port: 8787 }   # or { path: /run/247-agent-webhook/http.sock, mode: "0660" }
  max_body: 1048576                         # bytes; larger requests get 413
  drop_headers: []                          # more request headers to keep out of events
  trust_proxy: false                        # take `remote` from X-Forwarded-For (only behind your own proxy)
  routes:
    - path: /hooks/github
      event: github                         # with type_header: github.<X-GitHub-Event>
      type_header: X-GitHub-Event
      dedup_header: X-GitHub-Delivery       # a redelivery is dropped by the core
      verify: { kind: github, secret: "${secrets.github_webhook_secret}" }
    - path: /hooks/deploy
      event: deploy.requested
      methods: [POST]                       # the default
      verify: { kind: token, token: "${secrets.deploy_hook_token}" }   # Authorization: Bearer <token>
```

`routes` is required; everything else has the default shown.

### Routes

| key | default | meaning |
|---|---|---|
| `path` | required | exact request path (the query string is ignored); `/healthz` is reserved |
| `name` | the path, slugged (`hooks-github`) | appears in logs, the payload and the dedup key |
| `event` | required | the event type emitted, or its prefix with `type_header` |
| `type_header` | none | appends `.<header value>` to `event`, folded into one segment (`Pull Request` → `pull_request`); a request without it gets 400 |
| `dedup_header` | none | the delivery id; the event gets `dedup_key: <connector>:<route>:<value>` and a repeat is answered `200 {duplicate: true}` |
| `methods` | `[POST]` | anything else gets 405 |
| `verify` | required | how the request proves it is genuine (below) |

### `verify`

| kind | fields | checks |
|---|---|---|
| `github` | `secret` | `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>` (the webhook's secret in GitHub) |
| `gitlab` | `token` | `X-Gitlab-Token: <token>` (the webhook's secret token in GitLab) |
| `hmac` | `secret`, `header`, `algorithm` (`sha256`; `sha1`, `sha512`), `encoding` (`hex`; `base64`), `prefix` (`""`) | `<header>: <prefix><HMAC of the raw body>` |
| `token` | `token`, `header` (`Authorization`), `scheme` (`Bearer`; `""` for a bare token) | `<header>: <scheme> <token>` |
| `none` | | nothing; logged as a warning at start |

Comparisons are constant-time. A failed check answers `401 unauthorized` and logs one
line with the route, the peer and the reason (`signature mismatch`, `missing
x-hub-signature-256`), never the expected value. Secrets come from the secrets backend
through `${secrets.<name>}`; the connector never logs them.

## Events

One event per accepted request, `source: <connector name>`:

```json
{
  "type": "github.push",
  "dedup_key": "webhook:hooks-github:5f1c0a90-…",
  "payload": {
    "route": "hooks-github", "method": "POST", "path": "/hooks/github",
    "query": {}, "content_type": "application/json",
    "headers": { "x-github-event": "push", "x-github-delivery": "5f1c0a90-…", "user-agent": "GitHub-Hookshot/…" },
    "body_format": "json",
    "body": { "ref": "refs/heads/main", "repository": { "full_name": "acme/site" } },
    "remote": "127.0.0.1", "received_at": "2026-09-30T12:00:00.000Z"
  }
}
```

- `body` is parsed for `application/json` (and `*+json`; invalid JSON gets 400) and
  `application/x-www-form-urlencoded` (an object; a repeated key becomes an array);
  other UTF-8 bodies stay a string (`body_format: text`), anything else is base64
  (`body_format: base64`); an empty body is `null` (`empty`).
- `query` is the query string the same way.
- `headers` are lowercased and never include `authorization`, `cookie`,
  `proxy-authorization`, the route's signature or token header, nor `drop_headers`.
- `remote` is the peer address (`null` on a Unix socket), or the first
  `X-Forwarded-For` entry with `trust_proxy`.

The event lands in the database, so everything the sender puts in the body is stored:
don't route payloads you would not keep in a log.

## Deployment

The listener binds `127.0.0.1:8787` by default. Expose it through the reverse proxy that
already terminates TLS on the server, and forward only the webhook paths:

```nginx
location /hooks/ {
    proxy_pass http://127.0.0.1:8787;
    client_max_body_size 1m;
}
```

or listen on a Unix socket the proxy can reach (`listen: { path: …, mode: "0660" }`, with
the proxy's user in the socket's group).

`GET /healthz` answers `200 {"ok":true}` without touching the daemon, for the proxy's or a
monitor's checks. The port or socket being taken is fatal at start: the process exits
non-zero and the supervisor retries with backoff (`oa connector list` shows the error).

### GitHub

Repository → Settings → Webhooks → Add webhook: payload URL
`https://<your host>/hooks/github`, content type `application/json`, a random secret
(store the same value as `github_webhook_secret`), and the events you want. GitHub's
"Redeliver" sends the same `X-GitHub-Delivery`, which the dedup key drops.

## Tasks

```yaml
- name: deploy_on_push
  trigger:
    kind: event
    type: github.push
    filter: "payload.body.ref == 'refs/heads/main' && payload.body.repository.full_name == 'acme/site'"
  timeout: 10m
  action: { kind: shell, cmd: [/usr/local/bin/deploy-site] }

- name: review_requested
  trigger:
    kind: event
    type: github.pull_request
    filter: "payload.body.action == 'review_requested'"
  action:
    kind: connector
    connector: chat
    op: send
    args: { text: "Review requested: ${event.payload.body.pull_request.html_url}" }
```

A complete example is in [`examples/github-deploy.yaml`](examples/github-deploy.yaml).

## Development

```
connectors/webhook/src/
  config.ts   zod schema: listener, routes, verify kinds and their defaults
  verify.ts   HMAC and token checks over the raw body, constant-time
  server.ts   routing, body limit and parsing, the event payload, status codes
  main.ts     connectorEnv + CoreClient; listens, logs the routes, stops on SIGTERM
```

Tests run without the network beyond loopback: `server.test.ts` starts the server on a
random port (and on a Unix socket) against an in-memory core that honours `dedup_key`.
To try it by hand against a running daemon, put the manifest in `agent.yaml` and:

```
body='{"ref":"refs/heads/main"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -i localhost:8787/hooks/github -H 'content-type: application/json' \
  -H 'X-GitHub-Event: push' -H 'X-GitHub-Delivery: test-1' \
  -H "X-Hub-Signature-256: sha256=$sig" -d "$body"
oa events tail --type github.push
```
