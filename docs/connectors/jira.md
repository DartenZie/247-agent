# Jira

The jira connector is a thin wrapper over the Jira REST API, for Jira Cloud or for Data
Center and Server: **ops only**, no events of its own. Pair it with the built-in
[poller](poller.md) to turn a JQL search into events. Every issue key and every query is
confined to the projects listed in `projects`. Descriptions and comments are plain text
in and out; on Cloud the connector converts them from and to Atlassian's rich-text
format for you.

## Set it up

1. **Create a bot account** that can see only the projects your workflows need.
2. **Get credentials.** Cloud: an API token at id.atlassian.com → Security → API tokens;
   store the account's email as `jira_email` and the token as `jira_api_token`. Data
   Center: a personal access token from the profile page, stored as `jira_pat`; or a
   username and password if your instance has no tokens.
3. **Write the manifest** and `oa validate agent.yaml`. At start the connector calls
   Jira's "who am I" endpoint and logs the account; rejected credentials exit and the
   daemon retries with backoff. Credentials never appear in logs or op errors.

## Manifest

```yaml
name: jira
exec: ["247-agent-connector-jira"]
transport: stdio
ops: [search, get_issue, list_comments, create_issue, update_issue, add_comment,
      list_transitions, transition_issue]
config:
  base_url: https://acme.atlassian.net     # required
  deployment: cloud                        # cloud | datacenter; default: cloud for *.atlassian.net, else datacenter
  email: "${secrets.jira_email}"           # Cloud: the account's email …
  api_token: "${secrets.jira_api_token}"   # … and an API token
  # token: "${secrets.jira_pat}"           # Data Center: a personal access token instead
  # username: bot                          # Data Center without tokens: basic auth
  # password: "${secrets.jira_password}"
  projects: [SITE, OPS]                    # required; the first is create_issue's default
  timeout: 30000                           # per API call, ms
  max_text: 50000                          # characters a description or comment returns at most
```

Exactly one way to authenticate: `email` with `api_token`, `token` alone, or `username`
with `password`.

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `base_url` | required | your Jira site |
| `deployment` | by host name | `cloud` when `base_url` ends in `.atlassian.net`, otherwise `datacenter`. Cloud uses REST v3 and rich-text conversion; Data Center uses REST v2 and wiki markup as plain strings |
| `email`, `api_token` | none | Cloud credentials; set together |
| `token` | none | a Data Center personal access token |
| `username`, `password` | none | Data Center basic auth; set together |
| `projects` | required | one or more project keys such as `SITE`: upper-case, two characters or more, deduplicated. The first is the default project of `create_issue` |
| `timeout` | `30000` | per API call, in milliseconds |
| `max_text` | `50000` | a description or comment body is cut at this many characters |

## Scope

- Issue keys must belong to one of `projects` (`SITE-12`), checked before any request;
  `get_issue` also refuses an issue that was moved to another project since.
- `search` wraps every query as `project in (SITE, OPS) AND (<your JQL>) ORDER BY …`. A
  query whose parentheses or quotes do not balance is refused, so it cannot close that
  scope, and results from any other project are dropped as well. An empty query returns
  the project scope alone.
- `create_issue` only creates in `projects`; `update_issue` refuses to move an issue to
  another project.
- The manifest's `ops` list is the second boundary: an agent gets a copy with the read
  ops.

## Ops

| Op | Arguments | Returns |
|---|---|---|
| `search` | `jql` (may be empty; `ORDER BY` allowed), `fields` (extra field ids such as `customfield_10010`), `limit` (default 50, at most 1000) | `{ jql, issues: [{ key, id, url, project, summary, status, status_category, issue_type, priority, labels, assignee, reporter, created, updated, fields }] }`; `fields` is present only when extra fields were requested |
| `get_issue` | `key`, `fields`, `comments` (0 to 100: include that many latest comments) | the search fields plus `description` as plain text, and `comments` when asked for |
| `list_comments` | `key`, `limit` (default 20, at most 100) | `{ key, total, comments: [{ id, author, body, created, updated }] }`, the latest `limit` comments, oldest first |
| `create_issue` | `summary`, `project` (default the first of `projects`), `issue_type` (default `Task`), `description`, `labels`, `priority` (a name), `fields` (raw, merged in) | `{ key, id, url }` |
| `update_issue` | `key`, `summary`, `description`, `labels` (replaces), `priority`, `fields` | `{ key, updated: [field names] }`; at least one field is required |
| `add_comment` | `key`, `body` | `{ key, id, url }` |
| `list_transitions` | `key` | `{ key, transitions: [{ id, name, to }] }` |
| `transition_issue` | `key`, `transition` (a transition name, its id, or the status it leads to; case-insensitive), `comment`, `fields` | `{ key, transition, status }` |

`status_category` is Jira's `new`, `indeterminate` or `done`, stable across workflows, so
a filter like `payload.status_category == 'done'` survives renamed statuses. On Cloud,
plain text becomes one paragraph per blank-line-separated block with line breaks kept;
reading renders headings, lists, mentions, links and code as text. On Data Center, text
passes through as wiki markup.

Jira's error messages come back as the op's error text, for example
`POST /issue: summary: Field 'summary' cannot be set (400)`, and fail the calling run
without retry. A transition that does not exist lists the available ones in the error.

## Events, through the poller

```yaml
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

A task that picks an issue up and reports back:

```yaml
tasks:
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

Atlassian's official MCP server is a hosted service that authorises with OAuth in a
browser, which an unattended daemon cannot complete; that is why this wrapper exists.
Community servers that run locally, such as `mcp-atlassian` with `uvx`, are connectors
as-is when a Python runtime on the server is acceptable:

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

Its tool names, arguments and result shapes are its own, and it has no project allowlist.
Run an op with `oa run` to see the shape before writing a poller's `items` and `item_key`.
