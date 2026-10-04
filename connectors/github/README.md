# GitHub connector

A thin wrapper over the GitHub REST API: ops only, no events of its own, every op confined
to the repositories listed in `repos`, list ops shaped `{repo, <items>: […]}` for the
built-in poller. How to create a token, configure and use it, every op, the poller keys
and GitHub's own MCP server as an alternative:
[`docs/connectors/github.md`](../../docs/connectors/github.md). Example manifests:
[`docs/examples/connectors.d/github.yaml`](../../docs/examples/connectors.d/github.yaml)
and [`github-prs.yaml`](../../docs/examples/connectors.d/github-prs.yaml) (the poller).

## Development

```
connectors/github/src/
  config.ts   zod schema: token, repos (owner/name, lower-cased, deduplicated), api_base, limits
  api.ts      REST over fetch: auth headers, JSON, errors without the token, rate-limit reset
  ops.ts      repository scope, paging (min(100, limit) per page, 100 when filtering), result slimming, every op
  main.ts     runConnector: GET /user at start (a 403 is tolerated for an installation token), the op definitions (zod inputs)
```

`ops.test.ts` runs every op against a fake GitHub behind the injected `fetch` (routing by
method and path, recording calls): scope refusals, paging, the poller shape, write
payloads and error text. There is no smoke rig: GitHub cannot run in a container. To try
the real thing by hand:

```
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=github \
OA_CONFIG_JSON='{"token":"github_pat_…","repos":["acme/site"]}' \
bin/247-agent-connector-github
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with
`{"name":"list_pull_requests","arguments":{}}`).

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/github.yaml docs/examples/connectors.d/github-prs.yaml
```
