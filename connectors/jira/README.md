# Jira connector

A thin wrapper over the Jira REST API for Jira Cloud (API v3, rich text converted from
and to ADF) or Data Center (API v2): ops only, no events of its own, every key and query
confined to the projects listed in `projects`. How to get credentials, configure and use
it, every op, the poller keys and a community MCP server as an alternative:
[`docs/connectors/jira.md`](../../docs/connectors/jira.md). Example manifests:
[`docs/examples/connectors.d/jira.yaml`](../../docs/examples/connectors.d/jira.yaml) and
[`jira-issues.yaml`](../../docs/examples/connectors.d/jira-issues.yaml) (the poller).

## Development

```
connectors/jira/src/
  config.ts   zod schema: site, deployment (cloud for *.atlassian.net), exactly one auth scheme, project keys (^[A-Z][A-Z0-9_]+$), limits; credential scrubbing
  api.ts      REST over fetch: v3 or v2, auth header, errors without credentials
  adf.ts      Atlassian Document Format ↔ plain text
  ops.ts      project scope (keys, JQL wrapping with a balance check), paging (Cloud token, DC startAt), every op
  main.ts     runConnector: /myself at start, the op definitions (zod inputs)
```

`ops.test.ts` runs every op against a fake Jira behind the injected `fetch`, on both API
versions: scope refusals including a query that tries to close the project clause, both
paging schemes, ADF bodies, transitions by name, id and target status, and error text
without credentials. There is no smoke rig: Jira cannot run in a container.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/jira.yaml docs/examples/connectors.d/jira-issues.yaml
```
