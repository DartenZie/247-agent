# GitHub connector

A thin wrapper over the GitHub REST API: ops only (`transport: stdio`), no events of its
own. Pair it with the built-in `poller` to turn a list op into events ("a PR was opened",
"CI failed on main"), or with the [`webhook`](../webhook/README.md) connector when GitHub
can reach the server. Every op is confined to the repositories listed in `repos`, and list
ops wrap their array in an object (`{pull_requests: […]}`) so a poller's `items` has a name
to point at.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/github.yaml docs/examples/connectors.d/github-prs.yaml
```

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

### Token

A fine-grained personal access token (github.com → Settings → Developer settings), limited
to the repositories in `repos`, with read access to *Metadata*, *Contents*, *Pull
requests*, *Issues* and *Actions*, and write access only to what the listed write ops need
(*Issues* for `create_issue`/`update_issue`/`add_comment`/labels, *Pull requests* for
`create_pull_request`). A GitHub App installation token works as well. At start the
connector calls `GET /user` and logs who it is; a rejected token exits non-zero and the
supervisor backs off (`oa connector list` shows the error). The token never appears in
logs or op errors.

### Scope

- Every op takes an optional repository: `repo: "owner/name"`, or `owner` + `repo`
  (the shape the poller example uses); nothing means the first of `repos`. Anything not in
  `repos` fails before a request is made.
- `search_issues` always appends `repo:<owner/name>` and refuses queries that name
  `repo:`, `org:`, `user:` or `owner:` themselves.
- The manifest's `ops` is the second boundary: give an agent a copy of the manifest with
  the read ops only, and keep the write ops for tasks.

## Ops

List ops take `limit` (default 30, at most 1000; fetched 100 per page) and return
`{repo, <items>: […]}`.

| op | input | returns |
|---|---|---|
| `list_pull_requests` | `state` (`open`\|`closed`\|`all`, default `open`), `base`, `head`, `sort`, `direction` | `{repo, pull_requests: [{number, title, state, draft, url, user, labels, head: {ref, sha, repo}, base: {ref, sha}, created_at, updated_at, closed_at, merged_at}]}` |
| `get_pull_request` | `number` | the list fields + `body, merged, mergeable, mergeable_state, additions, deletions, changed_files, commits, requested_reviewers` |
| `get_pull_request_diff` | `number` | `{repo, number, diff, truncated}` (unified diff, cut at `max_text`) |
| `list_issues` | `state`, `labels` (all must match), `assignee`, `since` (ISO time), `sort`, `direction` | `{repo, issues: [{number, title, state, state_reason, url, user, labels, assignees, comments, created_at, updated_at, closed_at}]}`; pull requests are left out |
| `get_issue` | `number` | the list fields + `body, is_pull_request` |
| `list_comments` | `number`, `since` | `{repo, number, comments: [{id, url, user, body, created_at, updated_at}]}` (the conversation of an issue or PR) |
| `list_commits` | `sha` (branch, tag or commit; default branch), `path`, `since` | `{repo, commits: [{sha, url, message, author, date}]}` |
| `list_workflow_runs` | `workflow` (file name like `ci.yml`, or id), `branch`, `event`, `status` | `{repo, workflow_runs: [{id, name, url, event, status, conclusion, branch, sha, run_number, run_attempt, created_at, updated_at}]}` |
| `search_issues` | `query` (GitHub search syntax: `is:pr label:deploy author:x`) | `{repo, issues: [… , is_pull_request]}` |
| `create_issue` | `title`, `body`, `labels`, `assignees` | `{repo, number, url}` |
| `update_issue` | `number`, `title`, `body`, `state` (`open`\|`closed`), `state_reason`, `labels` (replaces), `assignees` | the issue fields |
| `add_comment` | `number`, `body` | `{repo, id, url}` |
| `add_labels` | `number`, `labels` | `{repo, number, labels}` (all labels now on it) |
| `remove_label` | `number`, `label` | `{repo, number, labels}` |
| `create_pull_request` | `title`, `head`, `base`, `body`, `draft` | `{repo, number, url}` |

GitHub's errors come back as the op's error text, e.g. `POST /repos/acme/site/issues:
Validation Failed: title is too long (422)`; a rate limit adds `(rate limited until
<time>)`. Either fails the calling run without retry, like every op error.

## Events, through the poller

The connector emits nothing. A `builtin: poller` manifest calls a list op on a cron and
emits one event per item it has not seen (ARCHITECTURE §6):

```yaml
# connectors.d/github-prs.yaml: one github.pr_opened per new pull request
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

The key decides what counts as new. Some useful ones:

| event | op and args | `items` | `item_key` |
|---|---|---|---|
| a PR opened | `list_pull_requests {state: open}` | `pull_requests` | `number` |
| a PR updated (new commits, edits) | `list_pull_requests {state: open, sort: updated, direction: desc}` | `pull_requests` | `join(':', [to_string(number), updated_at])` |
| a PR merged | `list_pull_requests {state: closed, sort: updated, direction: desc}` | `pull_requests[?merged_at]` | `number` |
| an issue labelled `website` | `list_issues {labels: [website]}` | `issues` | `number` |
| a failed CI run on main | `list_workflow_runs {workflow: ci.yml, branch: main, status: failure}` | `workflow_runs` | `id` |
| a new commit on main | `list_commits {sha: main}` | `commits` | `sha` |

A task then acts on the item, which is the event's payload. Here: label a new PR that
touches content and tell the chat (a review agent would read `get_pull_request_diff` the
same way, as a tool granted through `mcp_servers`):

```yaml
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

## Using GitHub's official MCP server instead

[`github-mcp-server`](https://github.com/github/github-mcp-server) (a Go binary, or the
`ghcr.io/github/github-mcp-server` image) is a connector as-is, with many more tools and
no wrapper to maintain; the trade-off is a non-JS dependency on the server, no repository
allowlist (the token's scope is the only limit) and GitHub's own result shapes:

```yaml
name: github
exec: ["github-mcp-server", "stdio", "--read-only", "--toolsets", "pull_requests,issues"]
transport: stdio
ops: [list_pull_requests, pull_request_read]      # whatever `oa connector list` + ops: [] show it serves
env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secrets.github_token}" }
```

Its list tools return GitHub's own JSON (typically the array itself), so a poller over it
leaves `items` out or adapts it; run the op once with `oa run` to see the shape before
writing `items` and `item_key`. Tool names and arguments follow that project's releases,
not this README.

## Development

```
connectors/github/src/
  config.ts   zod schema: token, repos, api_base, limits
  api.ts      REST over fetch: auth headers, JSON, errors without the token, rate-limit reset
  ops.ts      repository scope, paging, result slimming, every op
  main.ts     runConnector: GET /user at start, the op definitions (zod inputs)
```

`ops.test.ts` runs every op against a fake GitHub behind the injected `fetch` (routing by
method and path, recording calls): scope refusals, paging, the poller shape, write
payloads and error text. To try the real thing by hand:

```
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=github \
OA_CONFIG_JSON='{"token":"github_pat_…","repos":["acme/site"]}' \
bin/247-agent-connector-github
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with
`{"name":"list_pull_requests","arguments":{}}`).
