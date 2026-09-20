# Task field reference

Condensed from `docs/ARCHITECTURE.md` §3, §5 and the zod schema in
`packages/core/src/config/schema.ts`. The schema is strict: unknown keys are rejected.

## Tasks file

```yaml
tasks:
  - name: fetch_email                 # [a-z][a-z0-9_]*, unique across all tasks files
    trigger: { ... }                  # exactly one, see below
    action: { ... }                   # exactly one, see below
    concurrency: 1                    # runs of this task at once (default 1)
    timeout: 15m                      # per attempt of active work; `waiting` does not count
    retry: { attempts: 3, backoff: exponential, base: 30s, max: 1h }
    state_updates: { email.last_uid: "${result.last_uid}" }   # after success only
    emit: [ ... ]                     # routing, see below
    budget: { max_usd: 0.5 }          # accepted, applied once the ledger exists
    on_failure: ...                   # accepted, not applied yet
```

Defaults for `timeout` and `retry` come from `defaults:` in `agent.yaml`
(`15m` and one attempt unless configured).

## Triggers

| kind | fields | behaviour |
|---|---|---|
| `cron` | `schedule` (5-field cron), `tz` (IANA name, optional), `overlap: skip\|allow` (default `skip`) | Each tick publishes `cron.tick` with `payload: {task, scheduled_at}` and `dedup_key: cron:<task>:<scheduled_at>`. One run per tick; skipped while a run is queued/running/waiting unless `overlap: allow`. Missed ticks while the daemon was down are not replayed. |
| `event` | exactly one of `type` or `type_any: [...]`; optional `filter` (JMESPath over the whole event) | One run per matching event. `*` in a type pattern matches exactly one dot-separated segment. A filter that throws counts as no match and is logged. |
| `manual` | none | Only `oa run <task>`. |

Any task, whatever its trigger, can be started with `oa run <task>`; that publishes a
`manual.run` event and bypasses filters and cron overlap.

The event a task sees:

```json
{ "id": "evt_…", "type": "email.received", "source": "email",
  "ts": "2026-09-19T10:00:00Z", "correlation_id": "cor_…",
  "parent_id": "evt_…", "dedup_key": "email:<msg-id>", "depth": 0,
  "payload": { ... } }
```

`source` is a connector name, `scheduler`, `manual`, or `task:<name>`. Events deeper
than `limits.max_event_depth` (default 32) in a causal chain are dropped.

## Actions

### `shell`

```yaml
action:
  kind: shell
  cmd: ["lftp", "-e", "mirror -R --delete dist/ /public_html; quit", "sftp://ftp.example.cz"]
  cwd: /var/lib/247-agent/repos/site      # optional, templated
  env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }   # values must render to strings
  stdin: ${event.payload}                 # optional; non-strings sent as JSON
  result: text_stdout                     # default | json_stdout | exit_code
  sandbox: bwrap                          # none (default) | bwrap | { backend: bwrap, ro_binds, rw_binds, extra_args }
```

- `cmd` is argv. No shell unless you spell out `["bash", "-c", "…"]`.
- `text_stdout`: stdout as a string; non-zero exit fails the run (stderr tail in the error).
- `json_stdout`: stdout parsed as JSON (invalid JSON fails the run).
- `exit_code`: the exit code as a number; a non-zero exit is a result, not a failure.
- Runs as the service user; `user:` is not supported.
- `sandbox: bwrap` runs the command in bubblewrap: own pid namespace, OS read-only,
  private `/tmp`, `cwd` the only writable path (none: runs in `/tmp`), env cleared to the
  action's `env` + `PATH`/`HOME`/`LANG`, no core socket, no other process's environment.
  `ro_binds`/`rw_binds` add host paths at the same location, `extra_args` raw bwrap flags
  (`--unshare-net`). Default from `defaults.sandbox` in `agent.yaml`; `none` opts out.
  Use it for steps that run untrusted code (builds, tests, anything an agent produced);
  leave publishing steps that hold secrets and need the network unsandboxed.

### `connector`

```yaml
action:
  kind: connector
  connector: email            # manifest name, [a-z][a-z0-9_-]*
  op: fetch_new               # an MCP tool the manifest's `ops` allows ([] = any)
  args: { folder: INBOX, since_uid: "${state.email.last_uid}" }
  timeout: 60s                # default 60s
```

Result: the tool's `structuredContent`, else its text parsed as JSON when it is JSON.
An op outside the allowlist or an `isError` result fails without retry; a connector
that is down fails with retry.

### `wait`

```yaml
action:
  kind: wait
  for:
    type: chat.reply                                     # type pattern, `*` = one segment
    filter: "payload.correlation_id == '${event.correlation_id}'"
  timeout: 24h
  on_timeout: fail            # default | succeed → result {timed_out: true}
```

`for.filter` is rendered as a template first (so `${event…}` is the waiting run's own
trigger event), then evaluated as JMESPath over every incoming event. Events that
arrived between the trigger and the wait being armed are checked too. The run sits in
`waiting`, survives restarts, and its result is the matched event. A wait timeout fails
without retry.

### `sequence`

```yaml
action:
  kind: sequence
  steps:
    - { kind: connector, connector: chat, op: ask, args: { text: "Approve?", correlation_id: "${event.correlation_id}" } }
    - { kind: wait, for: { type: chat.reply, filter: "payload.correlation_id == '${event.correlation_id}'" }, timeout: 24h }
    - { kind: shell, when: "steps[1].payload.approved == `true`", cmd: [git, push, origin, "HEAD:main"] }
```

Steps are `shell`, `connector` or `wait`, each with an optional `when` (bare JMESPath
over the scope). `steps[i]` is the result of step i (`null` if skipped) for later
templates and `when`s. The run result is `{steps: [...]}`. A `wait` step checkpoints
the sequence; after a restart or retry it resumes there. Use a sequence only for
tightly coupled steps; anything another workflow might observe should be its own task
and event.

### `llm` and `agent`

Validated for `kind` only today; no runner yet. Full shape and design rules in the
`247-agent-model-actions` skill.

## Routing: `emit`

```yaml
emit:
  - type: email.received
    each: ${result.emails}              # single ${…} rendering to an array; one event per `item`
    dedup_key: "email:${item.message_id}"
    payload: ${item}
  - type: orchestra.classified
    when: "result.kind != 'ignore'"     # JMESPath over {event, result, state, env, run}
    payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

- Automatic events: `task.<name>.succeeded` (payload = result) and `task.<name>.failed`
  (payload = error, once, after the last retry attempt).
- Emitted events carry `source: task:<name>`, `parent_id` = the trigger event, and
  inherit its `correlation_id`.
- Rendering happens before anything is written; a rule that cannot render fails the
  run (no retry) and nothing is emitted.
- No `secrets` in `emit` or `state_updates`.

## `state_updates`

`<namespace>.<key>: <value or template>`, written after success in the same transaction
as the emitted events. Read back as `${state.<namespace>.<key>}` (a snapshot at run
start). Connectors use the same store under their own name via the API.

## Retry semantics

`retry: { attempts, backoff: fixed|exponential, base, max }`. Attempts belong to one
run; the run stays `running` between attempts. Retried: timeouts, connector down.
Not retried: wait timeout, missing secret, unknown connector, `isError` op result,
unrenderable `emit`. After the last attempt the run is `failed` and the event is not
redelivered.
