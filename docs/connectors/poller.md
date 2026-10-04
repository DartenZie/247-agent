# The built-in poller

Any op that lists things can become an event source without writing code. A manifest
with `builtin: poller` instead of `exec` runs inside the daemon, calls the op on a
schedule, remembers what it has seen, and emits one event per new item. It is how the
github and jira connectors, and any existing MCP server, become triggers.

## When to use it

Use the poller when the op returns "what exists now": open pull requests, issues with a
label, files in a folder, unread messages. The poller works out what is new by comparing
keys with the last poll.

When the op takes a cursor and returns only what is new (the email connector's
`fetch_new`), a cron task with `state_updates` for the cursor and `emit … each` for the
fan-out is the better fit; see [Routing](../tasks/routing.md).

## Manifest

```yaml
name: github_prs
builtin: poller
config:
  schedule: "*/5 * * * *"          # cron; optional tz: Europe/Prague
  connector: github                # a connector with ops that serves the op
  op: list_pull_requests
  args: { owner: acme, repo: site, state: open }   # ${secrets.<name>} and ${env.<VAR>} allowed
  items: "pull_requests"           # JMESPath over the op result → the array (default: the result)
  item_key: "number"               # JMESPath over one item → its identity (a string or a number)
  event: github.pr_opened          # emitted once per new key, the item as the payload
  first_run: emit                  # or skip: on the first poll, only remember what exists
  keep: 1000                       # how many seen keys to remember
  timeout: 30s                     # per op call
```

A poller is a connector without a process: its `transport` is `none`, it lists no `ops`,
and `cwd`, `env` and `health` do not apply. `emits` may be left out; it defaults to
`[<event>]`.

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `schedule` | required | a cron expression, like a cron trigger; optional `tz` |
| `connector` | required | the connector whose op is called. It must be a process connector that serves ops and lists the op in its `ops` |
| `op` | required | the op to call |
| `args` | `{}` | the op's arguments; values may use `${secrets.<name>}` and `${env.<VAR>}`, rendered fresh on every poll |
| `timeout` | 60 seconds | per op call |
| `items` | the whole result | a JMESPath expression over the op's result that yields the array of items |
| `item_key` | required | a JMESPath expression over one item that yields a string or a number: the item's identity |
| `event` | required | the event type emitted for each new item; the item is the payload |
| `first_run` | `emit` | `skip` marks everything the first poll returns as seen and emits nothing |
| `keep` | `1000` | how many seen keys are remembered |

## How it behaves

- The first poll happens at the next cron boundary, not at start.
- Each event carries `source: <poller name>` and `dedup_key: <poller name>:<key>`, so an
  item can never fire twice, even if you reset the poller.
- Seen keys live in the state store under the poller's name: `GET /v1/state/github_prs/seen`.
  Keys the op still returns are kept; keys that dropped out of the result stay until
  `keep` newer keys have pushed them out. Delete the `seen` key to treat everything as
  new again; the dedup key still blocks items the daemon has already stored.
- A tick while the previous poll is still running is skipped.
- A failed poll (the target connector down, an op error, a result that is not an array,
  an item without a key) is logged as `poller.failed` with the reason and tried again at
  the next tick. Nothing is emitted and the seen list is untouched.
- The events and the updated seen list are written together, so a crash between them
  cannot lose or duplicate an item.
- The poller re-reads any secret in `args` on every poll, so it needs no restart after a
  rotation. `oa connector restart` refuses it for that reason.

`oa validate` checks that `connector` names a process connector that lists `op` in its
`ops` (or has `ops: []`), and that `schedule`, `items`, `item_key` and `event` are
well-formed.

> [!TIP]
> Start with `first_run: skip` on anything that already has history. Otherwise the first
> poll emits one event for every open pull request, issue or file, and every task that
> listens runs once per item.

## Choosing the key

The key is what makes an item new. Three worked examples on the github connector:

**A pull request was opened.** The number identifies it; an existing one never fires again.

```yaml
config:
  connector: github
  op: list_pull_requests
  args: { repo: acme/site, state: open }
  items: pull_requests
  item_key: number
  event: github.pr_opened
```

**A pull request changed.** Fold the update time into the key, so every edit or new
commit is a new item. Sort by `updated` so the changed ones are in the page.

```yaml
config:
  connector: github
  op: list_pull_requests
  args: { repo: acme/site, state: open, sort: updated, direction: desc }
  items: pull_requests
  item_key: "join(':', [to_string(number), updated_at])"
  event: github.pr_updated
```

**A CI run failed on main.** The run id is unique per attempt.

```yaml
config:
  connector: github
  op: list_workflow_runs
  args: { repo: acme/site, workflow: ci.yml, branch: main, status: failure }
  items: workflow_runs
  item_key: id
  event: ci.failed
```

`items` can filter as well as select: `pull_requests[?merged_at]` keeps only merged pull
requests. Keep the op's `limit` above the number of items that can appear between two
polls, or sort so the newest come first.

## A complete example

The poller, its target, and a task that reacts:

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

```yaml
tasks:
  - name: announce_issue
    trigger: { kind: event, type: jira.issue_created }
    action:
      kind: connector
      connector: chat
      op: send
      args: { text: "New website issue ${event.payload.key}: ${event.payload.summary}\n${event.payload.url}" }
```

For an existing MCP server whose list tools return a bare array, leave `items` out and
run the op once with `oa run` to see the shape before choosing `item_key`.
