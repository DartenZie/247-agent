# GitHub

The github connector is a thin wrapper over GitHub's REST API: **ops only**, no events of
its own. Pair it with the built-in [poller](poller.md) to turn a list op into events ("a
pull request was opened", "CI failed on main"), or with the [webhook](webhook.md)
connector when GitHub can reach your server. Every op is confined to the repositories
listed in `repos`, and list ops wrap their array in an object (`{ pull_requests: […] }`)
so a poller's `items` has a name to point at.

## Set it up

1. **Create a token.** A fine-grained personal access token (github.com → Settings →
   Developer settings → Personal access tokens) limited to the repositories in `repos`,
   with read access to Metadata, Contents, Pull requests, Issues and Actions, and write
   access only to what your write ops need: Issues for `create_issue`, `update_issue`,
   `add_comment` and the label ops; Pull requests for `create_pull_request`. A GitHub
   App installation token works as well.
2. **Store it** as the secret `github_token`.
3. **Write the manifest** and `oa validate agent.yaml`. At start the connector asks
   GitHub who it is and logs the login; a rejected token exits and the daemon retries
   with backoff, with the error in `oa connector list`. The token never appears in logs
   or op errors.

## Manifest

```yaml
name: github
exec: ["247-agent-connector-github"]
transport: stdio
ops: [list_pull_requests, get_pull_request, get_pull_request_diff, list_issues, get_issue,
      list_comments, list_commits, list_workflow_runs, search_issues,
      create_issue, update_issue, add_comment, add_labels, remove_label, create_pull_request]
config:
  token: "${secrets.github_token}"      # required
  repos: [acme/site, acme/api]          # required; owner/name, the first is the default
  api_base: https://api.github.com      # https://<host>/api/v3 for GitHub Enterprise Server
  timeout: 30000                        # per API call, ms
  max_text: 200000                      # characters a body or a diff returns at most
```

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `token` | required | the personal access token or installation token |
| `repos` | required | one or more `owner/name` entries, lower-cased and deduplicated; the first is the default repository |
| `api_base` | `https://api.github.com` | `https://<host>/api/v3` for GitHub Enterprise Server |
| `timeout` | `30000` | per API call, in milliseconds |
| `max_text` | `200000` | an issue or comment body, or a diff, is cut at this many characters; `truncated` says so for a diff |

## Scope

- Every op takes an optional repository: `repo: "owner/name"`, or `owner` plus `repo`;
  nothing means the first of `repos`. A repository not in `repos` fails before any
  request is made.
- `search_issues` always appends `repo:<owner/name>` to the query and refuses a query
  that names `repo:`, `org:`, `user:` or `owner:` itself.
- The manifest's `ops` list is the second boundary: give an agent a copy of the
  manifest with the read ops only, and keep the write ops for tasks.

## Ops

List ops take `limit` (default 30, at most 1000) and return `{ repo, <items>: […] }`.
Pages are fetched as large as needed, up to 100 items each, so a `limit` of 30 is one
request.

| Op | Arguments | Returns |
|---|---|---|
| `list_pull_requests` | `state` (`open`, `closed`, `all`; default `open`), `base`, `head`, `sort`, `direction`, `limit` | `{ repo, pull_requests: [{ number, title, state, draft, url, user, labels, head: { ref, sha, repo }, base: { ref, sha }, created_at, updated_at, closed_at, merged_at }] }` |
| `get_pull_request` | `number` | the list fields plus `body`, `merged`, `mergeable`, `mergeable_state`, `additions`, `deletions`, `changed_files`, `commits`, `requested_reviewers` |
| `get_pull_request_diff` | `number` | `{ repo, number, diff, truncated }`, a unified diff cut at `max_text` |
| `list_issues` | `state`, `labels` (all must match), `assignee`, `since` (an ISO time), `sort`, `direction`, `limit` | `{ repo, issues: [{ number, title, state, state_reason, url, user, labels, assignees, comments, created_at, updated_at, closed_at }] }`; pull requests are left out |
| `get_issue` | `number` | the list fields plus `body` and `is_pull_request` |
| `list_comments` | `number`, `since`, `limit` | `{ repo, number, comments: [{ id, url, user, body, created_at, updated_at }] }`, the conversation of an issue or pull request |
| `list_commits` | `sha` (a branch, tag or commit; the default branch when unset), `path`, `since`, `limit` | `{ repo, commits: [{ sha, url, message, author, date }] }` |
| `list_workflow_runs` | `workflow` (a file name such as `ci.yml`, or an id), `branch`, `event`, `status`, `limit` | `{ repo, workflow_runs: [{ id, name, url, event, status, conclusion, branch, sha, run_number, run_attempt, created_at, updated_at }] }` |
| `search_issues` | `query` (GitHub search syntax: `is:pr label:deploy author:x`), `limit` | `{ repo, issues: [… plus is_pull_request] }` |
| `create_issue` | `title`, `body`, `labels`, `assignees` | `{ repo, number, url }` |
| `update_issue` | `number`, `title`, `body`, `state` (`open`, `closed`), `state_reason`, `labels` (replaces), `assignees` | the issue fields |
| `add_comment` | `number`, `body` | `{ repo, id, url }` |
| `add_labels` | `number`, `labels` | `{ repo, number, labels }`, every label now on it |
| `remove_label` | `number`, `label` | `{ repo, number, labels }` |
| `create_pull_request` | `title`, `head`, `base`, `body`, `draft` | `{ repo, number, url }` |

GitHub's errors come back as the op's error text, for example
`POST /repos/acme/site/issues: Validation Failed: title is too long (422)`; a rate limit
adds `(rate limited until <time>)`. Either fails the calling run without retry, like
every op error.

## Events, through the poller

The connector emits nothing. A `builtin: poller` manifest calls a list op on a schedule
and emits one event per item it has not seen:

```yaml
name: github_prs
builtin: poller
config:
  schedule: "*/5 * * * *"
  connector: github
  op: list_pull_requests
  args: { repo: acme/site, state: open }
  items: pull_requests
  item_key: number
  event: github.pr_opened
  first_run: skip
```

The key decides what counts as new:

| You want an event when | Op and arguments | `items` | `item_key` |
|---|---|---|---|
| a pull request is opened | `list_pull_requests { state: open }` | `pull_requests` | `number` |
| a pull request changes (new commits, edits) | `list_pull_requests { state: open, sort: updated, direction: desc }` | `pull_requests` | `join(':', [to_string(number), updated_at])` |
| a pull request is merged | `list_pull_requests { state: closed, sort: updated, direction: desc }` | `pull_requests[?merged_at]` | `number` |
| an issue gets the label `website` | `list_issues { labels: [website] }` | `issues` | `number` |
| a CI run fails on main | `list_workflow_runs { workflow: ci.yml, branch: main, status: failure }` | `workflow_runs` | `id` |
| a commit lands on main | `list_commits { sha: main }` | `commits` | `sha` |

A task then acts on the item, which is the event's payload. Here: label a new pull request
and tell the chat. A review agent would read `get_pull_request_diff` the same way, as a
tool granted through `mcp_servers`.

```yaml
tasks:
  - name: triage_pr
    trigger: { kind: event, type: github.pr_opened, filter: "payload.draft == `false`" }
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: github
          op: add_labels
          args: { number: "${event.payload.number}", labels: [needs-review] }
        - kind: connector
          connector: github
          op: add_comment
          args: { number: "${event.payload.number}", body: "Thanks! Queued for review." }
        - kind: connector
          connector: chat
          op: send
          args: { text: "PR #${event.payload.number}: ${event.payload.title}\n${event.payload.url}" }
```

> [!TIP]
> Set `first_run: skip` on the poller so the pull requests that are open when you install
> it are not treated as news.

## Using GitHub's own MCP server instead

[`github-mcp-server`](https://github.com/github/github-mcp-server) is a connector as-is,
with many more tools and no wrapper to maintain. The trade-off: a non-JavaScript program on
the server, no repository allowlist (the token's scope is the only limit), and GitHub's
own result shapes.

```yaml
name: github
exec: ["github-mcp-server", "stdio", "--read-only", "--toolsets", "pull_requests,issues"]
transport: stdio
ops: [list_pull_requests, pull_request_read]      # whatever it serves; start with ops: [] and pin
env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secrets.github_token}" }
```

Its list tools return GitHub's own JSON, typically the array itself, so a poller over it
leaves `items` out. Run an op once with `oa run` to see the shape before writing `items`
and `item_key`. Tool names and arguments follow that project's releases.
