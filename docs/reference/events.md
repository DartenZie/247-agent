# Events and log lines

Every event the daemon publishes by itself, the shape every event shares, how triggers
match, and the log lines worth searching for.

## The event record

```json
{ "seq": 1041, "id": "evt_01J8Z3ABCDEFGHJKMNPQRSTVWX", "type": "email.received",
  "source": "email", "ts": "2026-10-04T08:00:00.000Z",
  "correlation_id": "cor_01J8Z3…", "parent_id": "evt_01J8Z2…",
  "dedup_key": "email:<id@example.com>", "depth": 1,
  "payload": { "from": "editor@example.com", "subject": "Spring event" } }
```

| Field | Meaning |
|---|---|
| `seq` | the order events were stored in; the dispatcher and `GET /v1/events?after=` use it |
| `id` | `evt_` and 26 characters: a millisecond timestamp and random bits; sortable by time at millisecond resolution |
| `type` | dot-separated lower-case segments |
| `source` | who published it (below) |
| `ts` | when it was stored |
| `correlation_id` | `cor_…`; shared by every event and run that stem from one happening; inherited from the parent when there is one, else new |
| `parent_id` | the event this one was caused by, or `null` |
| `dedup_key` | the idempotency key, or `null`; a second event with the same key is dropped |
| `depth` | hops from the root of the causal chain: the parent's depth + 1, or 0 |
| `payload` | the data, or `null` |

Run ids look the same with `run_`. Ids are unique; `seq` is the order.

## Sources

| `source` | Who |
|---|---|
| the connector's name | a connector's `emitEvent` |
| the poller's name | a built-in poller |
| `scheduler` | cron ticks |
| `manual` | `oa run` and `POST /v1/runs` |
| `api` | `POST /v1/events` without a `source` |
| `core` | `budget.exceeded` and `llm.batch.ended` |
| `task:<name>` | the lifecycle and `emit` events of that task's runs |

A task never matches an event whose source is its own `task:<name>`, which is what keeps
a task that reports failures from looping on its own failure.

## Events the daemon publishes

| Type | Source | Dedup key | Parent | Payload |
|---|---|---|---|---|
| `cron.tick` | `scheduler` | `cron:<task>:<scheduled_at>` | none | `{ task, scheduled_at }` |
| `manual.run` | `manual` | none | none; the request's correlation id if given | `{ task, event: { type, payload } }` |
| `task.<name>.succeeded` | `task:<name>` | none | the run's trigger event | `{ run_id, task, result }` |
| `task.<name>.failed` | `task:<name>` | none | the run's trigger event | `{ run_id, task, error, attempt }` |
| your `emit` rules | `task:<name>` | the rule's `dedup_key`, rendered | the run's trigger event | the rule's `payload`, rendered |
| `budget.exceeded` | `core` | `budget:daily:<YYYY-MM-DD>` | none | `{ scope: "daily", day, limit_usd, spent_usd, task, run_id }` |
| `llm.batch.ended` | `core` | `llm.batch:<batch_id>` | the run's trigger event | see below |
| a poller's `event` | the poller's name | `<poller>:<item key>` | none | the item |

Examples:

```json
{ "type": "cron.tick", "source": "scheduler", "dedup_key": "cron:fetch_email:2026-10-04T08:02:00.000Z",
  "payload": { "task": "fetch_email", "scheduled_at": "2026-10-04T08:02:00.000Z" } }
```

`scheduled_at` is the tick's boundary: a minute for a five-field schedule, a second for
six or seven fields. Ticks missed while the daemon was down are not published.

```json
{ "type": "manual.run", "source": "manual",
  "payload": { "task": "classify_email", "event": { "type": "email.received", "payload": { "from": "…" } } } }
```

The action of the started run sees `payload.event` as its trigger event, under the
`manual.run` event's id and correlation id. The type defaults to `manual.input` and the
payload to `null`.

```json
{ "type": "task.classify_email.succeeded", "source": "task:classify_email",
  "payload": { "run_id": "run_01J8Z3…", "task": "classify_email", "result": { "kind": "general_change", "summary": "…" } } }
```

```json
{ "type": "task.publish_site.failed", "source": "task:publish_site",
  "payload": { "run_id": "run_01J8Z3…", "task": "publish_site", "error": "exit code 1: lftp: Login failed", "attempt": 3 } }
```

The failed event is published once, after the last attempt; `attempt` is that attempt's
number. Your own `emit` events are written in the same transaction as the succeeded
event, after it.

```json
{ "type": "budget.exceeded", "source": "core", "dedup_key": "budget:daily:2026-10-04",
  "payload": { "scope": "daily", "day": "2026-10-04", "limit_usd": 10, "spent_usd": 10.02,
               "task": "classify_email", "run_id": "run_01J8Z3…" } }
```

Published once per UTC day, by the call that crossed the cap or by the first call
refused after it. Route it to the task that tells you.

```json
{ "type": "llm.batch.ended", "source": "core", "dedup_key": "llm.batch:msgbatch_01…",
  "payload": { "batch_id": "msgbatch_01…", "run_id": "run_01J8Z3…", "task": "nightly_digest",
               "provider": "anthropic", "model": "claude-haiku-4-5", "status": "succeeded",
               "stop_reason": "end", "output": { "summary": "…" }, "usage": { "input": 812, "output": 90, "cache_read": 0, "cache_write": 0 },
               "usd": 0.00054, "priced_by": "table", "ledger_id": 78 } }
```

`status` is `succeeded`, `errored`, `expired` or `canceled`. A succeeded batch carries
`stop_reason` (`end`, `max_tokens`, `refusal`, `other`), `output` or `text`, `usage`,
`usd`, `priced_by` and `ledger_id`; a failed one carries `error` and `retryable`. The
event resumes the waiting run, and any other task may trigger on it.

## Type patterns

A type is 1 to 8 segments of `[a-z0-9_-]` joined by dots. In a trigger (`type`,
`type_any`), a `wait` (`for.type`) and `oa events tail --type`, a segment may be `*`,
which matches exactly one segment: `task.*.failed` matches `task.notify.failed`, not
`task.a.b.failed` or `task.failed`. There is no `**` and no partial wildcard such as
`task.fail*`. Where a concrete type is published (`emit`, a manifest's `emits`, a
poller's `event`, `POST /v1/events`) wildcards are refused.

## How an event starts a run

For every stored event, in order, the dispatcher:

1. ends every `wait` whose type pattern matches and whose filter is true for the event;
2. drops the event if its `depth` is above `limits.max_event_depth` (default 32), with
   an `event.depth_exceeded` warning; such an event still ended waits but starts no run;
3. for every task: skips it if the event's source is the task's own `task:<name>`;
   matches a `manual.run` whose `payload.task` is the task, whatever its trigger kind
   and without the filter; matches a `cron.tick` whose `payload.task` is the task,
   unless a run of the task is queued, running or waiting and `overlap` is `skip`;
   matches an event trigger when a pattern matches and the filter is true (a filter
   that throws is logged as `trigger.filter_error` and does not match);
4. creates one run per matched task. A run per task and event is unique, so a replay
   after a crash creates nothing twice.

A truthy filter result is anything but `null`, `false`, an empty string, an empty list
and an empty object; `0` counts as true.

## Log lines

The daemon writes one JSON object per line to stdout (journald under systemd):

```json
{ "ts": "2026-10-04T08:02:00.120Z", "level": "info", "msg": "run.succeeded",
  "run_id": "run_01J8Z3…", "task": "fetch_email", "correlation_id": "cor_01J8Z3…", "emitted": 2, "state_updates": 1 }
```

`msg` is the event name. Every line about a run carries `run_id`, `task` and
`correlation_id`; connector lines carry `connector`. Levels are `debug`, `info`, `warn`
and `error`; `log.level` in `agent.yaml` or `--log-level` sets the threshold.

```sh
journalctl -u 247-agent -o cat | jq 'select(.run_id == "run_01J8Z3…")'
journalctl -u 247-agent -o cat | jq 'select(.msg == "sandbox.net_denied")'
```

The names worth searching for:

| Name | Level | Meaning |
|---|---|---|
| `run.queued` | info | a run was created (`event_id`, `event_type`) |
| `run.started`, `run.resumed` | info | an attempt started, or continued after a wait (`attempt`) |
| `run.succeeded` | info | terminal success (`emitted`, `state_updates`) |
| `run.failed` | error | terminal failure (`error`, `attempt`) |
| `run.retry` | warn | an attempt failed and a retry is scheduled (`attempt`, `attempts`, `delay_ms`, `error`) |
| `run.waiting` | info | the run parked on a wait (`wait_type`, `expires_at`) |
| `run.recovered`, `run.abandoned` | warn | a run re-queued after a restart; a run left `running` by a stop |
| `wait.matched`, `wait.timeout` | info | a wait ended (`run_id`, `wait_type`, `event_id`) |
| `wait.filter_error` | warn | a wait's filter threw on an event; no match |
| `cron.armed` | info | a cron job armed (`task`, `schedule`, `next_run`) |
| `cron.skipped_overlap` | info | a tick skipped because a run of the task is active |
| `trigger.filter_error` | warn | a trigger filter threw on an event; no match |
| `event.depth_exceeded` | warn | an event past `limits.max_event_depth` started no run |
| `connector.up` | info | a connector is up (`pid`, `restarts`, `sandbox`, `network`) |
| `connector.exited`, `connector.failed` | warn, error | a connector stopped or could not start; a restart is scheduled |
| `connector.restart_scheduled` | info | the backoff before the next spawn (`delay_ms`, `restarts`) |
| `connector.output` | info | one line of a connector's stderr (`stream`, `line`) |
| `connector.unhealthy`, `connector.health_failed` | warn, error | a health ping failed; the limit was reached and the connector is respawned |
| `connector.unit_restart_needed` | warn | a changed manifest of a connector in its own unit needs `systemctl restart` |
| `poller.polled`, `poller.failed` | info, error | a poll finished (`items`, `new`, `emitted`), or failed (`error`) |
| `poller.seeded` | info | `first_run: skip` marked the first poll's items as seen |
| `llm.call`, `llm.decide`, `agent.turn` | info | a model call was ledgered (`provider`, `model`, tokens, `usd`, `priced_by`) |
| `budget.exceeded` | warn | the daily cap was crossed (`day`, `limit_usd`, `spent_usd`) |
| `llm.batch_submitted`, `llm.batch_ended` | info | a Message Batches request went out, or settled (`batch_id`, `status`) |
| `agent.permission` | info | a permission request was decided (`tool_kind`, `title`, `allowed`, `reason`) |
| `agent.policy_violation` | warn | the agent used a tool outside the policy without asking; the session was cancelled |
| `agent.config` | info | the model and effort the session ended up with |
| `agent.result`, `agent.result_missing` | info, warn | RESULT.json was read; or was missing after the first turn and a nudge follows |
| `agent.cancelling` | warn | the core is cancelling the session (`reason`: `budget`, `tool_calls`, `policy`, `abort`) |
| `sandbox.net_denied` | warn, then debug | a sandboxed agent asked for a host outside its allowlist (`host`, `port`); the first time per target is a warning |
| `sandbox.net_dropped` | warn once | a connection past the 256-connection limit was closed |
| `retention.purged` | info | what a retention pass deleted (`runs`, `ledger`, `transcripts`, `events`, `workspaces`) |
| `daemon.started`, `daemon.home` | info | the daemon is up; its version and install root |
| `core.config_warning` | warn | at start and on every reload, one line per expression `oa validate` warns about (`task`, `file`, `path`, `warning`); the config still loads |
| `daemon.reloaded`, `daemon.reload_invalid`, `daemon.reload_needs_restart` | info, error, warn | a reload applied, refused, or changed a key that needs a restart |
| `daemon.signal`, `daemon.stopped`, `daemon.crashed` | info, info, error | a signal arrived; the daemon stopped; an uncaught error stopped it |
| `api.stale_socket_removed` | warn | a dead daemon's socket file was removed at start |
