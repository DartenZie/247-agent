# Webhook

The webhook connector is HTTP in. It runs a small HTTP server that answers the paths you
list, checks every request (a GitHub signature, an HMAC, a shared token) and emits it as
one event. It is a **push-style**, emit-only connector (`transport: none`) with no ops.
Senders get a status they can act on: `202` emitted, `200` a redelivery that was dropped,
`4xx` do not retry, `503` the daemon is unreachable, retry later.

## Set it up

1. **Decide where it listens.** The default is `127.0.0.1:8787`. Expose that through the
   reverse proxy that already terminates TLS on your server, forwarding only the webhook
   paths:

   ```nginx
   location /hooks/ {
       proxy_pass http://127.0.0.1:8787;
       client_max_body_size 1m;
   }
   ```

   Or listen on a Unix socket the proxy can reach (`listen: { path: …, mode: "0660" }`
   with the proxy's user in the socket's group). A port below 1024 needs privileges the
   daemon does not have: run the connector in [its own unit](own-unit.md) with
   `AmbientCapabilities=CAP_NET_BIND_SERVICE`.
2. **Create a secret per route.** For GitHub: Repository → Settings → Webhooks → Add
   webhook, payload URL `https://<your host>/hooks/github`, content type
   `application/json`, a random secret, and the events you want. Store the same value as
   `github_webhook_secret`. GitHub's "Redeliver" button sends the same delivery id, which
   the dedup key drops.
3. **Write the manifest** and `oa validate agent.yaml`. The connector logs its routes at
   start; `GET /healthz` answers `200 {"ok":true}` without touching the daemon, for the
   proxy's or a monitor's checks.

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
      dedup_header: X-GitHub-Delivery       # a redelivery is dropped by the daemon
      verify: { kind: github, secret: "${secrets.github_webhook_secret}" }
    - path: /hooks/deploy
      event: deploy.requested
      methods: [POST]                       # the default
      verify: { kind: token, token: "${secrets.deploy_hook_token}" }   # Authorization: Bearer <token>
```

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `listen` | `{ host: 127.0.0.1, port: 8787 }` | a TCP address (`port: 0` picks a free one, shown in the log) or `{ path, mode }` for a Unix socket, `mode` an octal string, default `"0660"` |
| `routes` | required | at least one route; two routes cannot share a `path`, and `/healthz` is reserved |
| `max_body` | `1048576` | request bodies over this many bytes get 413 |
| `drop_headers` | `[]` | request headers to leave out of events, on top of the ones always dropped |
| `trust_proxy` | `false` | take the client address from the first `X-Forwarded-For` entry |

Per route:

| Key | Default | Meaning |
|---|---|---|
| `path` | required | the exact request path; the query string is ignored |
| `name` | the path, slugged (`hooks-github`) | appears in logs, the payload and the dedup key |
| `event` | required | the event type emitted, or its prefix when `type_header` is set |
| `type_header` | none | appends `.<header value>` to `event`, folded into one lower-case segment (`Pull Request` becomes `pull_request`, cut at 64 characters); a request without the header gets 400 |
| `dedup_header` | none | the delivery id header; the event gets `dedup_key: <connector>:<route>:<value>` and a repeat is answered `200 {"ok":true,"duplicate":true}` |
| `methods` | `[POST]` | anything else gets 405 with an `Allow` header |
| `verify` | required | how the request proves it is genuine, below |

`verify` kinds:

| Kind | Fields | Check |
|---|---|---|
| `github` | `secret` | `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>` |
| `gitlab` | `token` | `X-Gitlab-Token: <token>` |
| `hmac` | `secret`, `header`, `algorithm` (`sha256`; `sha1`, `sha512`), `encoding` (`hex`; `base64`), `prefix` (`""`) | `<header>: <prefix><HMAC of the raw body>` |
| `token` | `token`, `header` (`Authorization`), `scheme` (`Bearer`; `""` for a bare token) | `<header>: <scheme> <token>` |
| `none` | | nothing; logged as a warning at start |

Comparisons are constant-time. A failed check answers `401 unauthorized` and logs one line
with the route, the peer and the reason (`signature mismatch`, `missing
x-hub-signature-256`), never the expected value.

## Events

One event per accepted request, with `source` set to the manifest's name:

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
  `application/x-www-form-urlencoded` (an object; a repeated key becomes an array). Other
  UTF-8 bodies stay a string (`body_format: text`), anything else is base64
  (`body_format: base64`), and an empty body is `null` (`empty`).
- `query` is the query string, parsed the same way.
- `headers` are lower-cased and never include `authorization`, `cookie`,
  `proxy-authorization`, the route's signature or token header, any `x-hub-signature*`
  header, or `drop_headers`.
- `remote` is the peer address, `null` on a Unix socket, or the first `X-Forwarded-For`
  entry with `trust_proxy`.

> [!WARNING]
> The event lands in the database, so everything the sender puts in the body is stored.
> Do not route payloads you would not keep in a log.

## What the sender sees

| Status | Meaning |
|---|---|
| `202 {"ok":true,"event_id":"…"}` | emitted |
| `200 {"ok":true,"duplicate":true}` | the delivery id was seen before; nothing emitted |
| `400` | a missing `type_header`, a body that is not valid JSON or UTF-8 |
| `401` | the check failed |
| `404`, `405`, `413` | no such route, method not allowed, body over `max_body` |
| `422` | the daemon refused the event (it answered 4xx) |
| `503` with `Retry-After: 30` | the daemon is unreachable or answered 5xx; the sender should retry |
| `500` | an unexpected error, logged |

The port or socket being taken is fatal at start: the process exits and the daemon
retries with backoff, and `oa connector list` shows the error.

## Tasks

```yaml
tasks:
  - name: deploy_on_push
    trigger:
      kind: event
      type: github.push
      filter: "payload.body.ref == 'refs/heads/main' && payload.body.repository.full_name == 'acme/site'"
    concurrency: 1
    timeout: 10m
    action:
      kind: shell
      cmd: [/usr/local/bin/deploy-site, "${event.payload.body.after}"]

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

> [!TIP]
> Filter on the body in the trigger (`ref`, `repository.full_name`, `action`), so a push
> to a feature branch costs nothing. The dedup header means GitHub's "Redeliver" never
> deploys twice.

A complete example is [`github-deploy.yaml`](../../connectors/webhook/examples/github-deploy.yaml).
To test a route by hand, sign a body with your secret and post it:

```sh
body='{"ref":"refs/heads/main"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -i localhost:8787/hooks/github -H 'content-type: application/json' \
  -H 'X-GitHub-Event: push' -H 'X-GitHub-Delivery: test-1' \
  -H "X-Hub-Signature-256: sha256=$sig" -d "$body"
oa events tail --type github.push
```
