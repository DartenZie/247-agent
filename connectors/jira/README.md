# Jira connector

A thin wrapper over the Jira REST API, for Jira Cloud (API v3) or Data Center / Server
(API v2): ops only (`transport: stdio`), no events of its own. Pair it with the built-in
`poller` to turn a JQL search into events. Every issue key and every query is confined to
the projects listed in `projects`. Descriptions and comments are plain text in and out; on
Cloud the connector converts them from and to Atlassian Document Format.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/jira.yaml docs/examples/connectors.d/jira-issues.yaml
```

## Manifest

```yaml
name: jira
exec: ["247-agent-connector-jira"]
transport: stdio
ops: [search, get_issue, list_comments, create_issue, update_issue, add_comment,
      list_transitions, transition_issue]
config:
  base_url: https://acme.atlassian.net     # required
  deployment: cloud                        # cloud | datacenter; default: cloud for *.atlassian.net
  email: "${secrets.jira_email}"           # Cloud: the account's email …
  api_token: "${secrets.jira_api_token}"   # … and an API token
  # token: "${secrets.jira_pat}"           # Data Center: a personal access token (Bearer)
  # username: bot                          # Data Center without PATs: basic auth
  # password: "${secrets.jira_password}"
  projects: [SITE, OPS]                    # required; the first is create_issue's default
  timeout: 30000                           # per API call, ms
  max_text: 50000                          # characters a description or comment returns at most
```

Exactly one of `email` + `api_token`, `token`, or `username` + `password`.

### Credentials

- **Cloud:** create an API token at id.atlassian.com → Security → API tokens for a bot
  account that can see only the projects the workflows need. Store the email and the
  token as secrets.
- **Data Center:** a personal access token (profile → Personal Access Tokens) of such an
  account, as `token`.

At start the connector calls `/myself` and logs who it is; rejected credentials exit
non-zero and the supervisor backs off. Credentials never appear in logs or op errors.

### Scope

- Issue keys must belong to one of `projects` (`SITE-12`), checked before any request;
  `get_issue` also refuses an issue that was moved to another project since.
- `search` wraps the query: `project in (SITE, OPS) AND (<jql>) ORDER BY …`. A query whose
  parentheses or quotes do not balance is refused, so it cannot close that scope; results
  from any other project are dropped as well.
- `create_issue` only creates in `projects`; `update_issue` refuses `fields.project`.
- The manifest's `ops` is the second boundary: an agent gets a copy with the read ops.

## Ops

| op | input | returns |
|---|---|---|
| `search` | `jql` (may be `""`; `ORDER BY` allowed), `fields` (extra field ids, e.g. `customfield_10010`), `limit` (default 50, at most 1000) | `{jql, issues: [{key, id, url, project, summary, status, status_category, issue_type, priority, labels, assignee, reporter, created, updated, fields?}]}` |
| `get_issue` | `key`, `fields`, `comments` (0..100: include that many latest comments) | the search fields + `description` (plain text) and `comments` |
| `list_comments` | `key`, `limit` (default 20) | `{key, total, comments: [{id, author, body, created, updated}]}`, the latest `limit`, oldest first |
| `create_issue` | `summary`, `project`, `issue_type` (default `Task`), `description`, `labels`, `priority` (a name), `fields` (raw, merged in) | `{key, id, url}` |
| `update_issue` | `key`, `summary`, `description`, `labels` (replaces), `priority`, `fields` | `{key, updated: [field names]}` |
| `add_comment` | `key`, `body` | `{key, id, url}` |
| `list_transitions` | `key` | `{key, transitions: [{id, name, to}]}` |
| `transition_issue` | `key`, `transition` (a transition name, id, or the status it leads to; case-insensitive), `comment`, `fields` | `{key, transition, status}` |

`status_category` is Jira's `new`, `indeterminate` or `done`, stable across workflows, so
filters like `payload.status_category == 'done'` survive renamed statuses. Plain text
becomes one ADF paragraph per blank-line-separated block with hard breaks for single
newlines; reading renders headings, lists, mentions, links and code as text. On Data
Center, text is passed through as wiki markup.

Jira's error messages come back as the op's error text (`POST /issue: summary: Field
'summary' cannot be set (400)`), which fails the calling run without retry.

## Events, through the poller

```yaml
# connectors.d/jira-issues.yaml: one jira.issue_created per new matching issue
name: jira_new_issues
builtin: poller
config:
  schedule: "*/10 * * * *"
  connector: jira
  op: search
  args: { jql: "labels = website AND statusCategory = new ORDER BY created DESC", limit: 50 }
  items: issues
  item_key: key
  event: jira.issue_created
  first_run: skip
```

Other keys: `join(':', [key, status])` emits again whenever an issue changes status,
`join(':', [key, updated])` on any change. Keep `limit` above the number of issues the
query can match between two polls, or sort by `updated DESC` so the newest are always in
the page.

A task that works an issue and reports back:

```yaml
- name: work_website_issue
  trigger: { kind: event, type: jira.issue_created }
  action:
    kind: sequence
    steps:
      - kind: connector
        connector: jira
        op: get_issue
        args: { key: "${event.payload.key}", comments: 10 }
      - kind: connector
        connector: jira
        op: transition_issue
        args: { key: "${event.payload.key}", transition: In Progress, comment: "Picked up by 247-agent." }
```

## Using an MCP server instead

Atlassian's official MCP server is a hosted service that authorizes with OAuth in a
browser, which an unattended daemon cannot complete as a stdio child; that is why this
wrapper exists. Community stdio servers (for example `mcp-atlassian`, run with `uvx`) are
connectors as-is when a Python runtime on the server is acceptable:

```yaml
name: jira
exec: ["uvx", "mcp-atlassian"]
transport: stdio
ops: []                                    # list what it serves first, then pin the read ops
env:
  JIRA_URL: https://acme.atlassian.net
  JIRA_USERNAME: "${secrets.jira_email}"
  JIRA_API_TOKEN: "${secrets.jira_api_token}"
```

Its tool names, arguments and result shapes are its own (and it has no project
allowlist); run an op with `oa run` to see the shape before writing a poller's `items` and
`item_key`.

## Development

```
connectors/jira/src/
  config.ts   zod schema: site, deployment, one auth scheme, projects, limits
  api.ts      REST over fetch: v3 or v2, auth header, errors without credentials
  adf.ts      Atlassian Document Format ↔ plain text
  ops.ts      project scope (keys, JQL wrapping), paging (Cloud token, DC startAt), every op
  main.ts     runConnector: /myself at start, the op definitions (zod inputs)
```

`ops.test.ts` runs every op against a fake Jira behind the injected `fetch`, on both API
versions: scope refusals including a query that tries to close the project clause, both
paging schemes, ADF bodies, transitions by name, id and target status, and error text
without credentials.
