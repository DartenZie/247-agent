# `shell`

Run a command. This is the action for everything deterministic: a build, a mirror over
SFTP, a report, a script you already have. No model is involved.

## The smallest example

```yaml
tasks:
  - name: disk_report
    trigger: { kind: cron, schedule: "0 8 * * *" }
    action:
      kind: shell
      cmd: ["df", "-h", "/"]
      result: text_stdout
    emit:
      - type: report.disk
        payload: { text: "${result}" }
```

`cmd` is the command and its arguments as a list, run directly, without a shell. That
means no pipes, no `&&`, no globbing and no variable expansion unless you ask for a
shell explicitly:

```yaml
cmd: ["bash", "-c", "git pull --ff-only && npm run build"]
```

> [!TIP]
> Pass templated values into a script as arguments or through `env`, never by pasting
> them into the script text, where a quote in the data would break the command:
>
> ```yaml
> cmd: ["bash", "-c", 'echo "core said: $GREETING"']
> env: { GREETING: "${event.payload.greeting}" }
> ```

## What the result is

`result` chooses what the run's result becomes:

| `result` | The result | A non-zero exit |
|---|---|---|
| `text_stdout` (default) | standard output as text, one trailing newline removed | fails the run; the error carries the last 1024 characters of stderr |
| `json_stdout` | standard output parsed as JSON | fails the run; so does output that is not JSON |
| `exit_code` | the exit code as a number | is a result, not a failure |

Use `exit_code` for checks whose answer is the status (`curl --fail`, `test -f`). With
`json_stdout`, print only JSON on stdout and send diagnostics to stderr. The daemon
keeps up to 8 MiB of each stream.

`stdin` sends data to the command: a string as it is, anything else encoded as JSON.
`stdin: ${event.payload}` is how you hand a script the whole event payload.

```yaml
action:
  kind: shell
  cmd: ["python3", "scripts/handle.py"]
  stdin: ${event.payload}
  result: json_stdout
```

## Working directory and environment

`cwd` is where the command runs; `env` adds variables. Both are templated. Without a
sandbox the command inherits the daemon's environment plus `env`, and `PATH` starts
with the install's `bin/` and its own Node, so the bundled tools, `node`, `npm` and
`npx` resolve wherever the daemon is installed.

A secret goes into `env`, where it stays out of process listings:

```yaml
action:
  kind: shell
  cwd: /var/lib/247-agent/repos/website
  env: { LFTP_PASSWORD: "${secrets.ftp_pass}" }
  cmd: ["lftp", "-u", "deploy,env:LFTP_PASSWORD", "-e", "mirror -R --delete dist/ /public_html; quit", "sftp://ftp.example.com"]
```

## The sandbox

A command that builds or tests something an agent produced is running untrusted code.
`sandbox: bwrap` runs it inside bubblewrap:

```yaml
action:
  kind: shell
  cwd: ${run.workspace}
  cmd: ["npm", "test"]
  sandbox: bwrap
```

Inside the sandbox the command sees the operating system (`/usr`, `/lib`, `/lib64`,
`/bin`, `/etc`) and the daemon's install read-only, a private `/tmp`, and `cwd` as the
only writable directory. Its environment is cleared down to `env` plus `PATH`, `HOME`
(set to `cwd`) and `LANG`. The daemon's socket, database, configuration directory and
secrets file are hidden even where `/etc` would show them, other processes are
invisible, and the command cannot reach the daemon's API.

The long form adds mounts and raw bubblewrap flags:

```yaml
sandbox:
  backend: bwrap
  ro_binds: [/srv/data]              # host paths mounted read-only at the same place
  rw_binds: []                       # host paths mounted writable
  extra_args: ["--unshare-net"]      # raw bwrap flags; --unshare-net cuts the network
```

Set `defaults.sandbox: bwrap` in `agent.yaml` to sandbox every `shell` action, and opt
out on the ones that need the network and a secret, such as the publishing step, with
`sandbox: none`. Agent `post` gates run through this action with the same default.

> [!WARNING]
> Without `cwd`, a sandboxed command runs in the private `/tmp` with nothing else
> writable. And the sandbox lives inside the systemd unit's own restrictions: a
> directory the command writes to still needs `ReadWritePaths=` in the unit. See
> [Production](../operations/production.md).

The sandbox needs the `bubblewrap` package and unprivileged user namespaces on the
host; the packages recommend it. `oa validate` refuses a `cwd` or a bind that would
expose the daemon's database, socket, configuration or secrets file to the command.

## Failures and retries

A non-zero exit (except with `result: exit_code`), a command that could not be started,
or a command killed by a signal fails the attempt. These failures are retried under the
task's `retry` policy. When the attempt times out, the command gets `SIGTERM`, then
`SIGKILL` five seconds later.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `cmd` | yes | | the command and its arguments, as a list; no shell |
| `cwd` | no | the daemon's | working directory; templated; the one writable path in a sandbox |
| `env` | no | | extra environment variables; values templated |
| `stdin` | no | | data for standard input; a string as is, anything else as JSON |
| `result` | no | `text_stdout` | `text_stdout`, `json_stdout` or `exit_code` |
| `sandbox` | no | `defaults.sandbox` | `none`, `bwrap`, or `{ backend, ro_binds, rw_binds, extra_args }` |
