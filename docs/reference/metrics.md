# Metrics reference

Every metric the daemon exposes on `GET /metrics`, in Prometheus text format, and how to
get it into a scraper.

## Scraping

The daemon serves metrics on its Unix socket, which Prometheus cannot scrape directly.
Two ways in:

- `oa metrics` prints the exposition. Run it from a systemd timer into a
  node_exporter textfile collector:

  ```sh
  oa metrics > /var/lib/node_exporter/textfile/247-agent.prom.tmp \
    && mv /var/lib/node_exporter/textfile/247-agent.prom.tmp /var/lib/node_exporter/textfile/247-agent.prom
  ```

- Put a small HTTP proxy in front of the socket and point Prometheus at it:

  ```nginx
  location /metrics { proxy_pass http://unix:/run/247-agent/core.sock:/metrics; }
  ```

Counters live in memory and reset when the daemon restarts; use `rate()` or
`increase()`. Gauges marked "at scrape" are computed when `/metrics` is read.

## Metrics

All names start with `oa_`. Histograms use the buckets 0.01, 0.05, 0.1, 0.5, 1, 5, 15,
60, 300, 900 and 3600 seconds.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `oa_build_info` | gauge, at scrape | `version` | always 1, labelled with the version |
| `oa_uptime_seconds` | gauge, at scrape | | seconds since the daemon started |
| `oa_config_tasks` | gauge, at scrape | | tasks in the active configuration |
| `oa_config_reloads_total` | counter | `result` (`ok`, `invalid`) | reloads by outcome |
| `oa_events_published_total` | counter | `type`, `result` (`inserted`, `duplicate`) | events published, and whether they were stored or dropped as duplicates |
| `oa_events_dropped_total` | counter | `reason` (`depth`) | events past `limits.max_event_depth` |
| `oa_runs_queued_total` | counter | `task` | runs created |
| `oa_run_attempts_total` | counter | `task` | attempts started, retries included |
| `oa_runs_finished_total` | counter | `task`, `status` (`succeeded`, `failed`) | runs that reached a terminal status |
| `oa_run_duration_seconds` | histogram | `task` | seconds from a run being queued to its terminal status |
| `oa_waits_ended_total` | counter | `task`, `outcome` (`matched`, `timeout`) | waits that ended |
| `oa_runs_pending` | gauge, at scrape | | runs queued for a worker |
| `oa_runs_in_flight` | gauge, at scrape | | runs executing now |
| `oa_runs_waiting` | gauge, at scrape | | runs parked in a wait |
| `oa_cron_ticks_total` | counter | `task` | cron ticks published |
| `oa_cron_next_run_timestamp_seconds` | gauge, at scrape | `task` | Unix time of the next tick |
| `oa_model_calls_total` | counter | `provider`, `model`, `task` | model calls ledgered: `llm`, `decide` and agent turns |
| `oa_model_tokens_total` | counter | `provider`, `model`, `direction` (`input`, `output`, `cache_read`, `cache_write`) | tokens ledgered |
| `oa_model_cost_usd_total` | counter | `provider`, `model`, `task` | dollars ledgered |
| `oa_model_spend_today_usd` | gauge, at scrape | | dollars ledgered since 00:00 UTC |
| `oa_model_daily_budget_usd` | gauge, at scrape | | `budgets.daily_usd`; absent when unset |
| `oa_budget_exceeded_total` | counter | `scope` (`daily`, `task`) | calls refused or runs failed over a budget |
| `oa_llm_batches_total` | counter | `provider`, `status` (`submitted`, `succeeded`, `errored`, `expired`, `canceled`, `abandoned`, `poll_failed`) | Message Batches requests by what happened |
| `oa_llm_batches_pending` | gauge, at scrape | | batches submitted and not settled |
| `oa_connector_up` | gauge, at scrape | `connector`, `transport` | 1 when the connector is up; a built-in poller is always 1 |
| `oa_connector_restarts_total` | counter | `connector` | respawns scheduled after a crash or a failed start |
| `oa_connector_ops_total` | counter | `connector`, `op`, `result` (`ok`, `error`) | connector operations called, including through an agent's tool bridge |
| `oa_connector_op_duration_seconds` | histogram | `connector`, `op` | seconds per operation call |
| `oa_connector_health_checks_total` | counter | `connector`, `result` (`ok`, `failed`) | health pings |
| `oa_sandbox_net_requests_total` | counter | `connector`, `result` (`allowed`, `denied`, `failed`, `dropped`) | what sandboxed agent programs asked their network allowlist proxy for |
| `oa_retention_deleted_total` | counter | `kind` (`events`, `runs`, `ledger`, `transcripts`, `workspaces`) | rows and directories removed by retention |
| `oa_retention_runs_total` | counter | `result` (`ok`, `failed`) | retention passes |
| `oa_retention_last_success_timestamp_seconds` | gauge | | Unix time of the last completed retention pass |
| `oa_db_size_bytes` | gauge, at scrape | | size of the SQLite database |
| `oa_api_requests_total` | counter | `method`, `status` | API requests |

## Label cardinality

Labels are bounded by the configuration, never by ids. The `type` label of
`oa_events_published_total` is the exact type only when the daemon or a task names it:
the daemon's own types (`cron.tick`, `manual.run`, `budget.exceeded`, `llm.batch.ended`,
every `task.<name>.succeeded` and `.failed`), every exact type in a trigger's `type` or
`type_any`, in a `wait`'s `for.type` and in an `emit` rule. Anything else, including
types matched only through a wildcard, is counted as `other`. The set is rebuilt on every
reload. `oa_connector_up` and `oa_cron_next_run_timestamp_seconds` are reset on every
scrape, so removed connectors and tasks disappear.

## Examples

Spend against the daily cap, as a fraction:

```promql
oa_model_spend_today_usd / oa_model_daily_budget_usd
```

Failed runs by task over the last hour:

```promql
sum by (task) (increase(oa_runs_finished_total{status="failed"}[1h]))
```

A connector that is down, for an alert:

```promql
oa_connector_up == 0
```

Other useful ones: `increase(oa_sandbox_net_requests_total{result="denied"}[1h])` to see
an agent asking for hosts you have not allowed, `oa_runs_waiting` for approvals waiting
on a human, and `time() - oa_retention_last_success_timestamp_seconds` to notice a
retention pass that stopped running.
