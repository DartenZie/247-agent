# Troubleshooting

| Symptom / error | Cause | Fix |
|---|---|---|
| `oa` cannot connect | Daemon not running, or a different socket path | `--socket`, or `OA_CORE_SOCKET` = `socket:` from `agent.yaml` resolved against its directory |
| daemon refuses to start, socket in use | A live daemon owns the socket | Stop it first; a stale file from a dead one is replaced automatically |
| socket path error on macOS | Path longer than 104 bytes | Use a short dir like `/tmp/247-agent` |
| cron task never runs | A run is still queued/running/waiting and `overlap: skip` | `GET /v1/runs?task=<name>`; wait, fix the stuck run, or `overlap: allow` |
| cron task ran nothing while the daemon was down | Missed ticks are not replayed | `oa run <task>` once |
| event task never runs | Filter false or throws, type mismatch, or the event's `source` is the task's own runs | `oa emit <type> payload.json` and inspect; check the filter with backtick literals for numbers/booleans; remember `*` is one segment |
| `secret "x" is not set` | Backend has no value | `env` backend: `<prefix><X>` upper-cased; `file`: key in the YAML/JSON map; systemd: `LoadCredential=x:…` |
| `no runner` | The task is `llm` or `agent` | Not runnable yet; use a `shell` stand-in for testing |
| `op … not allowed` | Op missing from the manifest's `ops` | Add it or use `ops: []` |
| connector … is down (retried) | Process crashed or never started | Read `connector.output` lines; run the connector by hand with the `OA_*` env |
| `wait` resumed with the wrong event | `for.filter` too loose | Match on `payload.correlation_id == '${event.correlation_id}'` |
| `wait` timed out immediately after restart | The timeout passed while the daemon was down | Expected; the run failed without retry, `task.<name>.failed` fired |
| templates appear as literal `${…}` | Unquoted template inside a YAML flow mapping, or `${…}` used in `filter`/`when` | Quote inside `{ … }`; `filter`/`when` take bare JMESPath |
| `each must be a single ${…}` | `each` has text around the template | `each: ${result.items}` only |
| `secrets cannot be used here` | `secrets` in `emit` or `state_updates` | Move the secret into the action |
| `a task never triggers on its own … event` | Trigger on `task.<self>.succeeded\|failed` | Trigger on a domain event the task emits, or on another task |
| run failed with stderr tail, `shell` | Non-zero exit with `text_stdout`/`json_stdout` | Fix the command, or use `result: exit_code` if non-zero is a legitimate outcome |
| `json_stdout` parse error | Command printed non-JSON | Print only JSON on stdout; send diagnostics to stderr |
| run is `running` for a long time | Between retry attempts (backoff) or waiting on `timeout` | `GET /v1/runs/{id}` shows `attempt` and the last error |
| event dropped, `depth` | Chain deeper than `limits.max_event_depth` (32) | You have a loop: task A emits what triggers B which emits what triggers A. Break it with a filter or a `dedup_key` |
| duplicate event ignored (200) | Same `dedup_key` already published | Intended; change the key if it is a genuinely new item |
