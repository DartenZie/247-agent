# Monitoring

What to watch, where the numbers come from, and how the daemon keeps its own database
from growing forever.

## Metrics

The daemon exposes Prometheus metrics at `GET /metrics` on its Unix socket; `oa metrics`
prints them. Prometheus cannot scrape a Unix socket itself, so either write the output
to a node_exporter textfile collector on a timer or put a small HTTP proxy in front of
the socket.

A textfile collector, as a systemd timer running every minute:

```sh
# /usr/local/bin/247-agent-metrics
oa metrics > /var/lib/node_exporter/textfile/247-agent.prom.tmp \
  && mv /var/lib/node_exporter/textfile/247-agent.prom.tmp /var/lib/node_exporter/textfile/247-agent.prom
```

Every metric starts with `oa_`. The ones that matter first:

| Metric | Why you watch it |
|---|---|
| `oa_model_spend_today_usd`, `oa_model_daily_budget_usd` | today's model spend against the daily cap; the cap gauge exists only when `budgets.daily_usd` is set |
| `oa_budget_exceeded_total{scope}` | calls refused or runs failed over a budget, `daily` or `task` |
| `oa_runs_finished_total{task,status}` | runs that ended `succeeded` or `failed`, per task |
| `oa_run_duration_seconds{task}` | a histogram from queued to finished, per task |
| `oa_runs_pending`, `oa_runs_in_flight`, `oa_runs_waiting` | the queue, the workers busy now, and runs parked for an event or an approval |
| `oa_connector_up{connector,transport}` | 1 when a connector is up; a built-in poller is always 1 |
| `oa_connector_restarts_total{connector}` | respawns after a crash or a failed start |
| `oa_connector_ops_total{connector,op,result}` | operations called, `ok` or `error` |
| `oa_sandbox_net_requests_total{connector,result}` | what sandboxed agents asked their network allowlist for: `allowed`, `denied`, `failed`, `dropped` |
| `oa_events_published_total{type,result}` | events inserted or dropped as duplicates; `type` is `other` unless a task names the type exactly |
| `oa_retention_last_success_timestamp_seconds` | when the last retention pass completed |
| `oa_config_reloads_total{result}` | reloads, `ok` or `invalid` |

Counters reset when the daemon restarts; `oa_build_info{version}` and
`oa_uptime_seconds` tell you when that happened. The [metrics reference](../reference/metrics.md)
lists every metric with its labels.

Queries that make useful alerts:

```promql
# spend is past 80 % of today's cap
oa_model_spend_today_usd / oa_model_daily_budget_usd > 0.8

# a task failed in the last hour
increase(oa_runs_finished_total{status="failed"}[1h]) > 0

# a connector is down
oa_connector_up == 0

# something has been waiting for an approval for more than a day
oa_runs_waiting > 0   # then look at oa runs ls --status waiting

# an agent keeps asking for a host you did not allow
increase(oa_sandbox_net_requests_total{result="denied"}[1h]) > 0
```

## Cost

Every model call is a ledger row: the run, the task, the provider, the model, input and
output tokens, cache reads and writes, dollars, and how the price was determined
(`table` from the built-in or configured price, `provider` when the provider reported
the cost, `unpriced` when neither was possible, which fails the run so it is noticed). An
agent turn is a row under the connector's name as provider.

`oa cost` sums the ledger:

```sh
oa cost                              # by task, last 24 hours
oa cost --by model --since 7d
oa cost --by provider --since 2026-09-01
oa cost --by day --since 30d --json
```

```
task               calls     in_tok    out_tok   cache_rd        usd
classify_email        41      18234       1927      16100     0.0319
update_event_list      3     120414       8860      98210     0.4120
total since 2026-10-03T19:00:00.000Z: $0.4439
```

`--since` takes a duration (`7d`, `24h`) or a timestamp. `oa runs show <id>` prints the
rows of one run with their total, and `GET /v1/runs/<id>/ledger` returns them as JSON.

## Retention

Without retention the database and the agents' `work/` directory would grow forever.
Once at start and then every `retention.interval` the daemon deletes, in this order and
only for finished runs:

1. runs older than `retention.runs`, counted from when they finished, together with their
   ledger rows, their transcript and their wait record; a run whose batched model call is
   still in flight is kept;
2. ledger rows older than `retention.ledger` that belong to finished runs;
3. events older than `retention.events` that have been dispatched and that no remaining
   run or wait refers to, so a kept run always keeps the event that triggered it;
4. agent workspaces under `work/` whose run finished longer ago than
   `retention.workspaces`, and directories with no run at all that old; a git worktree
   is detached from its repository and its `agent/<run_id>` branch deleted.

```yaml
retention: { events: 90d, runs: 90d, ledger: 90d, workspaces: 7d, interval: 1h }   # the defaults
```

`never` keeps a kind forever. `runs` and `ledger` must be at least `1d`, because the daily
budget is summed from today's ledger rows, and `ledger` cannot outlive `runs`, because
ledger rows go with their run. Active runs, their events and their workspaces are never
touched, whatever the durations.

Every pass logs `retention.purged` with the counts (at info level when something was
deleted) and updates `oa_retention_deleted_total{kind}`, `oa_retention_runs_total{result}`
and `oa_retention_last_success_timestamp_seconds`.

> [!NOTE]
> A dedup key is only unique among the events still kept. An item older than
> `retention.events` could be emitted again by a connector that does not remember it
> itself. The built-in poller remembers what it has seen in state, so it is not affected.

## Health

`GET /v1/health` answers without touching anything expensive:

```sh
curl --unix-socket /run/247-agent/core.sock http://unix/v1/health
```

```json
{ "ok": true, "pid": 4120, "started_at": "2026-10-04T06:00:00.000Z", "uptime_s": 48213,
  "config_file": "/etc/247-agent/agent.yaml", "tasks": 8, "runs": { "pending": 0, "in_flight": 1 } }
```

`oa connector list` shows every connector's state, pid, restart count, sandbox and
network setting and, for a manifest with `health:`, the last MCP ping (`health=ok`,
`failing(n)` or `unchecked`).

Next: [Troubleshooting](troubleshooting.md).
