# Troubleshooting

Symptom, cause, fix. The quoted messages are what `oa` or the daemon prints, so you can
search this page for them. Everything the daemon knows is in its database and reachable
over the socket, so the loop is always the same: reproduce with `oa run` or `oa emit`,
read the run with `oa runs show`, read the log lines that share its `run_id`, fix,
`oa validate`, repeat.

## Connecting and starting

| Symptom | Cause | Fix |
|---|---|---|
| `cannot connect to the daemon at /run/247-agent/core.sock (ENOENT). Is 247-agent-core running? Set --socket or OA_CORE_SOCKET.` | the daemon is not running, or the socket is elsewhere | `systemctl status 247-agent`; for a local daemon `export OA_CORE_SOCKET=<the socket: in agent.yaml, resolved against that file's directory>` |
| the same with `EACCES` | your user may not open the socket (mode `0660`) | run `oa` with `sudo`, or add yourself to the `247-agent` group |
| the daemon exits with `another daemon is listening on <path>` | a live daemon owns the socket | stop it first; a stale file from a dead daemon is replaced on its own |
| the daemon exits with `invalid agent config <file>:` and `<path>: <message>` lines, or `invalid connector config:` | the configuration does not validate | `oa validate <agent.yaml>` prints the same issues without starting anything; fix and restart |
| `no tasks files found` | the `tasks:` paths in `agent.yaml` name no `*.yaml` file | check the paths; they are relative to the directory of `agent.yaml` |
| socket error on macOS | Unix socket paths are limited to 104 bytes | use a short directory such as `/tmp/247-agent` |

## Tasks that do not run

| Symptom | Cause | Fix |
|---|---|---|
| a cron task never runs | a previous run is still queued, running or waiting and `overlap` is `skip`; the log says `cron.skipped_overlap` | `oa runs ls --task <name>`: finish or fix the stuck run, or set `overlap: allow` |
| a cron task ran nothing while the daemon was down | missed ticks are not replayed | `oa run <task>` once |
| an event task never runs | the filter is false or throws (`trigger.filter_error` in the log); the type does not match (`*` is exactly one segment); the event came from the task's own runs; or the event is too deep in a chain (`event.depth_exceeded`) | `oa emit <type> payload.json` and `oa runs ls`; compare numbers and booleans with backticks in the filter; a task never triggers on events its own runs produced |
| `oa validate` says `a task never triggers on its own "task.x.succeeded" event` | the trigger names the task's own lifecycle event | trigger on a domain event the task emits, or on another task's event |
| `exactly one of "type" or "type_any" is required` | an event trigger with both or neither | keep one |
| `schedule "…" never fires` or croner's `exactly five, six, or seven space separated parts are required` | a bad cron expression | fix the schedule; 5, 6 or 7 fields, seconds first when 6 or 7 |

## Configuration errors

| Symptom | Cause | Fix |
|---|---|---|
| `secret "x" is not set (OA_SECRET_X)` | the `env` backend has no such variable | set `<prefix><NAME>` upper-cased in the daemon's environment and restart |
| `cannot read secrets file …: mode must be 0600 (readable by the service user only)` | the `file` backend refuses a file readable by group or others | `chmod 600` and make the service user the owner |
| `secret "x": CREDENTIALS_DIRECTORY is not set (not started by systemd?)` | the `systemd-credentials` backend outside systemd | run under the unit, or use the `env` or `file` backend for a local daemon |
| `secret "x" is not available: …` | no `LoadCredential=x:…` line in the unit's drop-in | add it with `systemctl edit 247-agent`, then restart |
| templates appear literally as `${…}` | an unquoted template inside a YAML flow mapping, or `${…}` used in `filter` or `when` | quote inside `{ … }`; `filter` and `when` take bare JMESPath |
| `each must be a single ${…} template that renders to an array` | `each` has text around the template | `each: ${result.items}` only |
| `secrets cannot be used here: they would be written to the store or an event` | `secrets` inside `emit` or `state_updates` | move the secret into the action |
| `reference secrets by name (secrets.<name>), not as a whole` | `${secrets}` used whole | name the secret |
| `state keys are <namespace>.<key>, each [a-z0-9_-]+` | a `state_updates` key without a dot or with other characters | `email.last_uid` |
| `no provider: set action.provider or defaults.llm.provider in agent.yaml` | an `llm` or `decide` task with no provider anywhere | add `providers:` and a default, or `provider:` on the action |
| `unknown provider "x" (not in providers: of agent.yaml)` | a typo, or the provider was not declared | declare it under `providers:` |
| `decide needs an openrouter provider (the Decisions API); "x" is type anthropic` | the classification model is served by OpenRouter only | point `provider:` or `defaults.decide.provider` at a provider of type `openrouter` |
| `batch: true needs an anthropic provider (Message Batches); "x" is type openrouter` | only Anthropic has a batch API | use an `anthropic` provider or drop `batch` |
| `no price for model "m" on provider "p" (type openai): add a pricing entry in agent.yaml` | the built-in price table does not know the model | add `pricing: { m: { input: …, output: … } }` in USD per million tokens; OpenRouter models need none |
| `no price for model "m": add a pricing entry in agent.yaml (or omit model when the agent reports cost)` | an `agent` task names a model without a price | add a price, or omit `model` when the agent program reports cost itself |
| `system_file not found: …` or `system_file must stay under the config directory` | a wrong or escaping path | paths are relative to the directory of `agent.yaml` and must stay under it |
| `<repo> is not visible to the sandboxed agent program "claude": add it to sandbox.ro_binds` | the agent's manifest sandbox does not bind the repository | add it to `ro_binds` (`rw_binds` only if the agent itself commits) |

## Runs that fail

| Symptom | Cause | Fix |
|---|---|---|
| a `shell` run fails with `exit code 1: <stderr tail>` | the command failed | fix the command; if a non-zero exit is a legitimate outcome, use `result: exit_code` |
| `stdout is not JSON: …` | `result: json_stdout` and the command printed something else | print only JSON on stdout, diagnostics to stderr |
| `<connector>.<op>: not in the manifest's ops` | the op is not in the manifest's `ops` allowlist | add it, or set `ops: []` to allow every op the connector serves |
| `<connector>.<op>: <message>`, no retry | the connector's op raised an error | fix the arguments or the remote side; op errors are never retried on purpose |
| `unknown connector "x"` | no manifest with that name is loaded | `oa connector list`; check `connectors:` in `agent.yaml` and the file names under `connectors.d/` |
| `connector "x" is down`, the run is retried | the connector process is not up | read its `connector.output` lines in the log; `oa connector list` shows the last error |
| a connector restarts every few seconds | it exits or crashes at start (bad credentials, a port in use, invalid config); the log shows `connector.exited` and `connector.restart_scheduled` with a growing delay | run it by hand with `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and `OA_CONFIG_JSON` set and read its stderr |
| a `builtin: poller` never emits | the target connector is down, the op errors, or the result has another shape; the log line `poller.failed` names the reason; `poller.polled` with `new: 0` means nothing changed; `first_run: skip` seeds the seen list silently | fix the target or `items`/`item_key`; the seen keys are at `GET /v1/state/<poller>/seen` |
| `output truncated at max_tokens 512; raise it or shorten the task` | the model's answer did not fit | raise `max_tokens` or ask for less |
| `the model refused the request` | the provider refused; not retried | change the prompt or the input |
| a run fails over its budget | the worst case before the call or the actual cost after it exceeded `budget.max_usd`; the ledger row is kept | raise the budget or shrink the input; `oa runs show <id>` lists the calls |
| every model call fails fast, `budget.exceeded` was published, the message says `model-backed tasks resume at 00:00 UTC` | the daily cap `budgets.daily_usd` is reached | wait for midnight UTC, or raise the cap and `oa reload`; the triggering events can be replayed with `oa run --event` |
| an agent run failed or came back `blocked` | a refused tool call, the tool-call cap, the budget, a missing `RESULT.json`, or the agent's own judgement | `oa runs logs <id>`: a `permission … refused` row names the command or path, a `cancel` row says which limit was hit (`budget`, `tool_calls`, `policy`, `abort`), the `result` row holds the summary |
| `agent ran a tool call outside the policy without asking (…); session cancelled` | the agent used a tool or ran a command without a permission request, and it was not in `tools` or `bash_allow` | add the read-only commands the agent runs on its own (`git status`, `git diff`) to `bash_allow`; for Codex set `unasked_execute: sandboxed` |
| `agent exceeded max_tool_calls (20); session cancelled` | the cap | raise `max_tool_calls` or narrow the task |
| a sandboxed agent cannot reach a host; `CONNECT tunnel failed, response 403` or npm `E403` | the host is not in the manifest's `sandbox.network.allow`; the daemon logs `sandbox.net_denied` with the host and port | add the entry (`registry.npmjs.org` for an agent started with `npx`) and `oa reload`, which respawns the agent |
| a sandboxed connector stays `down` with a spawn error | `bubblewrap` is not installed, or user namespaces are disabled | install it; see [production](production.md) |
| a `wait` resumed with the wrong event | the filter is too loose | match on `payload.correlation_id == '${event.correlation_id}'` |
| a `wait` timed out right after a restart | the timeout passed while the daemon was down | expected; the run failed once and `task.<name>.failed` fired |
| `oa emit` says `duplicate dedup_key=…` | an event with that key already exists | intended; change the key if it is a genuinely new item |
| a run has been `running` for a long time | it is between retry attempts, or its attempt has not reached `timeout` yet | `oa runs show <id>` shows the attempt and the last error; for an agent run `oa runs logs <id> --follow` shows what it is doing |
| `interrupted: the daemon restarted while the run was in progress` | the daemon stopped mid-run and the retry policy had no attempts left | give the task `retry.attempts: 2` or more if a second try is worth it, or replay the event |

## Reload and restart

| Symptom | Cause | Fix |
|---|---|---|
| `reload refused: the previous config stays active`, exit 1 | a file is invalid; the issues are printed above it | fix them; `oa validate` shows the same |
| `restart required for: db, socket` on stderr after a successful reload | those keys only apply at start | `systemctl restart 247-agent` |
| a changed manifest of a connector in its own unit did nothing; the log says `connector.unit_restart_needed` | the daemon does not run that process | `systemctl restart 247-agent-connector@<name>` |
| `oa connector restart` answers `connector "x" is built in: it re-reads its secrets on every poll, nothing to restart` | a poller needs no restart | nothing to do |

Still stuck? `oa runs show <id>` for the run, `journalctl -u 247-agent -o cat | jq
'select(.run_id=="<id>")'` for its log lines, and the [events reference](../reference/events.md)
for what each log name means.
