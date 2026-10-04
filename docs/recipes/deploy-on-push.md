# Deploy when GitHub pushes to main

Every push to the `main` branch of one repository should run your deploy script on the
server, once, and only when the request really came from GitHub.

## What you need

- The [webhook connector](../connectors/webhook.md), which listens for HTTP requests and
  turns each verified one into an event.
- A reverse proxy such as nginx that already terminates TLS on the server, forwarding
  the webhook path to the connector.
- A random secret, stored once in GitHub's webhook settings and once in your secrets
  backend under the name `github_webhook_secret`.
- A deploy script the daemon's user may run, here `/usr/local/bin/deploy-site`.

## The manifest

`connectors.d/webhook.yaml`:

```yaml
name: webhook
exec: ["247-agent-connector-webhook"]
transport: none
emits: [github.push, github.pull_request]
config:
  listen: { host: 127.0.0.1, port: 8787 }
  routes:
    - path: /hooks/github
      event: github                      # becomes github.<X-GitHub-Event>: github.push, github.pull_request
      type_header: X-GitHub-Event
      dedup_header: X-GitHub-Delivery    # a redelivery of the same delivery id is dropped
      verify: { kind: github, secret: "${secrets.github_webhook_secret}" }
```

## The tasks

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
      cmd: ["/usr/local/bin/deploy-site", "${event.payload.body.after}"]

  - name: announce_pull_request
    trigger:
      kind: event
      type: github.pull_request
      filter: "payload.body.action == 'opened'"
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "New pull request: ${event.payload.body.pull_request.html_url}" }
```

## The proxy

```nginx
location /hooks/ {
    proxy_pass http://127.0.0.1:8787;
    client_max_body_size 1m;
}
```

Then in the repository: Settings, Webhooks, Add webhook. Payload URL
`https://<your host>/hooks/github`, content type `application/json`, the secret, and the
events you want (pushes and pull requests here).

## How it works

1. GitHub posts to `/hooks/github`. The connector checks the `X-Hub-Signature-256`
   header against the raw body and your secret, in constant time. A bad or missing
   signature gets a `401` and one log line naming the route and the reason, never the
   expected value.
2. The route's `event` is `github`, and `type_header` appends the event name GitHub
   sends, lower-cased: `github.push`, `github.pull_request`.
3. `dedup_header` turns GitHub's delivery id into the event's dedup key. When you press
   Redeliver in GitHub, the connector answers `200` with `{"ok":true,"duplicate":true}`
   and nothing runs twice. A new delivery is answered `202` with the event id.
4. The event payload holds the parsed JSON body under `body`, plus the request's
   `headers` (without the signature header or any credential header), `method`, `path`,
   `query` and `received_at`. That is why the filter reads `payload.body.ref`.
5. The filter keeps pushes to `main` of `acme/site`; a push to a branch is stored as an
   event and starts nothing. The deploy script gets the new commit sha as its argument.
   `concurrency: 1` queues a second push behind the first instead of running two deploys
   at once.

Check it from the server before GitHub does:

```sh
body='{"ref":"refs/heads/main","after":"abc123","repository":{"full_name":"acme/site"}}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -i localhost:8787/hooks/github -H 'content-type: application/json' \
  -H 'X-GitHub-Event: push' -H 'X-GitHub-Delivery: test-1' \
  -H "X-Hub-Signature-256: sha256=$sig" -d "$body"
oa events tail --type github.push
oa runs ls --task deploy_on_push
```

## Make it yours

- **GitLab, or any sender.** `verify: { kind: gitlab, token: "${secrets.gitlab_token}" }`
  checks the `X-Gitlab-Token` header; `kind: hmac` and `kind: token` cover most others.
  See the [webhook connector](../connectors/webhook.md) for every kind.
- **Only a tag, only a path.** Anything in the body is a filter away:
  `starts_with(payload.body.ref, 'refs/tags/')`.
- **Build in a sandbox.** If the deploy builds untrusted contributions, give the shell
  action `sandbox: bwrap` and keep the publishing step, which holds credentials and needs
  the network, in a separate task on `task.deploy_on_push.succeeded`.

> [!WARNING]
> The whole request body lands in the event and therefore in the database. Do not route
> payloads you would not keep in a log, and leave `drop_headers` to strip anything the
> sender adds that you do not want stored.

> [!NOTE]
> A port below 1024 or a socket in a directory the daemon cannot write needs privileges
> the daemon does not have. Run the connector in [its own systemd unit](../connectors/own-unit.md)
> with `AmbientCapabilities=CAP_NET_BIND_SERVICE`, or keep it on `127.0.0.1:8787` behind
> the proxy as above.

> [!TIP]
> While the daemon is unreachable the connector answers `503` with `retry-after: 30`.
> GitHub does not retry on its own; use Redeliver in the webhook's Recent Deliveries once
> the daemon is back. The dedup key makes that safe.
