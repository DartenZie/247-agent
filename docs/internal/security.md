# Security

The trust model, what each sandbox hides and keeps, how secrets flow, and the layers
around an agent. Open it when touching `packages/core/src/actions/sandbox*.ts`,
`connectors/net-proxy.ts`, `secrets/`, `connectors/child-env.ts`, the units, or
anything that moves a credential or a process across the boundary described here. The
user-facing explanation is [`../concepts/security.md`](../concepts/security.md).

## The trust model

The daemon's uid is the boundary. The core and the connectors it spawns run as
`247-agent`; any process with that uid can connect to the socket API, which has no
authentication of its own, and read the other processes' environments through
`/proc/<pid>/environ`. A process running as `247-agent` is therefore trusted by
definition, and the daemon's own code and the connectors an operator installed are
meant to be. Everything that executes content the daemon did not write, an `agent`
action or a `shell` step marked untrusted, must not run with that reach: it runs in a
sandbox that unshares the pid namespace and hides the socket, the database, the
configuration and the daemon's environment. Moving secrets from the environment to a
file or a pipe would change nothing; only the namespace split does.

The units add the OS layer: `User=247-agent`, `ProtectSystem=strict`, `PrivateTmp`,
`NoNewPrivileges`, `RuntimeDirectory` for the socket, `StateDirectory` for the
database and workspaces. A setuid `bwrap` does not work under `NoNewPrivileges=yes`
and the unit must not set `RestrictNamespaces=`: sandboxing needs unprivileged user
namespaces. Paths a sandboxed step writes to still need `ReadWritePaths=`, because
the sandbox lives inside the unit's mount namespace.

## Secrets

`secrets/secrets.ts`. Configuration names a secret (`${secrets.ftp_pass}`,
`[a-zA-Z][a-zA-Z0-9_]*`); the backend supplies the value:

| Backend | Reads | Reload |
|---|---|---|
| `env` | `<prefix><NAME upper-cased>`, default prefix `OA_SECRET_` | daemon restart |
| `file` | a YAML or JSON map at `path` (relative to `agent.yaml`), re-read on every resolve, refused when any group or other mode bit is set ("mode must be 0600"); not read when a run needs no secrets | every resolve |
| `systemd-credentials` | `$CREDENTIALS_DIRECTORY/<name>` from the unit's `LoadCredential=` lines, one trailing newline stripped | service restart |

Where a value goes, and nowhere else:

- A run resolves only `task.secretNames`, the names the action's templates reference,
  per attempt; they enter the `secrets` template scope of `action` only. `emit` and
  `state_updates` render without that scope (`config/schema.ts`), `${secrets}` as a
  whole is refused, and the `env` scope omits what the backend reads through
  (`scrubEnv()`: the `env` backend's prefixed variables, or `CREDENTIALS_DIRECTORY`
  under `systemd-credentials`).
- An unsandboxed `shell` step or `post` gate starts from that same scrubbed set
  (`ctx.childEnv`) plus the action's `env`, never from the daemon's environment.
  Otherwise a command that prints its environment, by design or in a build tool's
  error output, would store every secret in the run result and the
  `task.<name>.succeeded` payload. The scrub limits accidental exposure. It is not a
  boundary: the command runs as the daemon's uid and can still read the daemon's
  `/proc/<pid>/environ` or the credentials directory. Only the sandbox is a boundary.
- A provider's `api_key` and `headers` are resolved per model call inside the
  `ctx.llm` service and handed to the adapter; never to a runner.
- A connector's `config` and `env` are rendered at spawn (`connectors/child-env.ts`,
  `connectorChildEnv()`) and again on `oa connector restart`; `OA_CONFIG_JSON` carries
  them into that one process, and the SDK's `connectorEnv()` deletes the variable after
  reading it so children do not inherit it. The built-in poller renders `${secrets.*}`
  in `args` fresh on every poll.
- The agent transcript replaces resolved values of 4 characters or more with
  `[secret:<name>]` before a row is written ([`agent-action.md`](agent-action.md)).
- There is no secrets endpoint on the API and none may be added: a pull endpoint
  would hand every local process every secret.

A connector that must hold a secret the daemon should not see, or needs privileges
(a port below 1024, a device, another user's files), runs in its own unit with
`managed_by: systemd` ([`connectors.md`](connectors.md)): the unit's
`247-agent-connector-host` resolves that connector's secrets from the unit's own
`LoadCredential=` lines and the daemon never does. Drop-ins set `User=`, capabilities
and credentials; `Group=247-agent` stays, which is how it reads `/etc/247-agent` and
the daemon's socket (created `0660`), and the daemon's state directory is hidden from
it.

## The shell sandbox

`sandbox: bwrap` on a `shell` action or `post` gate (`actions/sandbox.ts`,
`buildSandboxArgv()`; the full argv is in [`actions.md`](actions.md)): own pid and ipc
namespaces, the OS directories and the install read-only, a private `/tmp`, `cwd`
the only writable path, an environment of the action's `env` plus `PATH`, `HOME`,
`LANG` when the daemon has it. The protected set, `protectedPaths()` in `config/agent.ts`, is the database,
the socket, the `<socket>.net` directory, `agent.yaml` and a `file` backend's secrets
file; their directories are masked with an empty tmpfs, and a file whose directory
cannot be masked (it is `/etc` itself, or the install) is bound to `/dev/null`.
`oa validate` refuses a `cwd` or a bind that would show a protected file
(`config/crosscheck.ts`, `checkSandboxes`). The network stays the host's unless
`extra_args: ["--unshare-net"]`. Steps that hold deploy secrets and need the network
run unsandboxed and keep the secret in `env`, not argv.

## The agent program's sandbox

`sandbox` on an `acp` manifest (and only there: every other connector needs the core
socket the sandbox hides) wraps the long-lived program once
(`connectors/supervisor.ts`, `spawnSandboxed`): the OS and the install read-only,
`defaults.agent.work_dir` the one writable path, holding every run's workspace and
the program's home `<work_dir>/home/<name>` (`HOME`; npm and Claude Code caches live
there, the retention sweep ignores it), the manifest's `ro_binds`/`rw_binds` (the
repositories worktrees come from, read-only unless the agent itself commits), the
protected set masked, and after `--clearenv` an environment of exactly `PATH` (with
`<OA_HOME>/bin` and the daemon's Node first), `HOME` (that home), the manifest's `env`
and `OA_CONNECTOR_NAME`, nothing of the daemon's (`connectors/child-env.ts`,
`connectorChildEnv()`; `actions/sandbox.ts`, `buildSandboxArgv()`). `LANG` and
`OA_HOME` are passed only when the supervisor's base environment has them, and that
base is the MCP SDK's default set, `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`
(`connectors/supervisor.ts`, `getDefaultEnvironment()`; `core.ts` passes no `env`), so
in the daemon they are not. An unsandboxed `acp` agent gets that base set plus the
manifest's `env` and `OA_CONNECTOR_NAME`; a `stdio` or `none` connector gets the base
set plus the manifest's `env`, `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and
`OA_CONFIG_JSON`. No `acp` connector, sandboxed or not, receives `OA_CORE_SOCKET` or
`OA_CONFIG_JSON` (`config` is refused on the manifest). The sandbox is per program, so concurrent runs share it and
an agent can see other runs' workspaces under `work_dir`, as it could inside one
process. `oa validate` refuses a bind or `work_dir` covering a protected file or the
proxy sockets, a `cwd` outside every bind, and an `agent` task whose `workspace.repo`
the sandboxed connector cannot see; a changed `work_dir` on reload respawns sandboxed
agents. Without the `bubblewrap` package the spawn fails and the connector stays down
with the error in `oa connector list`.

## The network allowlist

`sandbox.network: { allow: [...] }` (`actions/sandbox-net.ts`,
`connectors/net-proxy.ts`). bwrap can only share the network or cut it off, so an
allowlist is three parts:

1. `--unshare-net`: an empty namespace with a loopback, no route, no DNS.
2. A filtering HTTP proxy the core serves for this one sandbox on a Unix socket in
   `<core socket>.net/` (directory 0700, socket 0600; a directory every sandbox masks
   and `oa validate` keeps out of binds), bound read-only into the sandbox at
   `/tmp/.247-agent-net.sock`, so another agent cannot borrow the list.
3. A bridge inside the sandbox (the daemon's Node running `sandbox-net.ts` inline)
   that listens on `127.0.0.1:<free port>`, pipes every connection to the socket, and
   starts the agent with `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`
   pointing at itself, `NO_PROXY`/`no_proxy` for loopback and `NODE_USE_ENV_PROXY=1`;
   it filters nothing and the ACP stdio is inherited, not relayed.

Entries are `host[:port]`: a hostname, `*.suffix` (names strictly below the suffix,
never the suffix itself, never an IP literal), an IPv4 address or `[IPv6]`; the port a
number or `*`, default 443; an exact entry wins over a wildcard. The proxy serves
`CONNECT` and absolute-form `http://` requests to listed targets, rewrites the `Host`
header to the judged authority, strips hop-by-hop headers, connects upstream directly
with a 30 s timeout, and answers 403 for anything else, 400 for a malformed request,
502 when upstream fails. Names are resolved by the proxy on the host and the
connection goes to the address that was checked. A wildcard match refuses (403) a
name that resolves to a loopback, private, CGNAT, link-local, multicast or reserved
address, a ULA or site-local one, Teredo (`2001::/32`), 6to4 (`2002::/16`) or `::/96`,
and judges NAT64 (`64:ff9b::/96`) by the embedded IPv4: a name anyone can register
under an allowed suffix must not reach the host's own services or a cloud metadata
endpoint. An exact host or address entry is the operator's word and resolves anywhere.
`allow: []` is no network at all: no proxy, no bridge.

Limits and logging: `sandbox.net_denied` and `sandbox.net_failed` at warn the first
time per target, debug after, up to `MAX_NOTED` 256 targets, then
`sandbox.net_log_limit` once; `maxConnections` 256 open connections per sandbox,
tunnels included, a further one closed unanswered and `sandbox.net_dropped` (warn
once); `oa_sandbox_net_requests_total{connector,result}` with `allowed`, `denied`,
`failed`, `dropped`. The proxy lives as long as the process; a respawn gets a new one;
a changed list is a changed manifest, so a reload respawns the agent.

What it does not do: it never reads a tunnel, so TLS stays end to end and the list
limits where the agent talks, not what it says (an allowed host that accepts uploads
is still a way out: list hosts, not clouds). Only what honours the proxy variables
gets out: Claude Code, Node, npm, curl and git over HTTPS do; git over SSH and raw
sockets do not. `network` needs `backend: bwrap` and refuses `--share-net` in
`extra_args`.

## The agent's capability surface

Layers, each one assuming the one before it can fail
([`agent-action.md`](agent-action.md) has the mechanics):

1. A fresh workspace per run; the base checkout is never edited.
2. `tools` and `bash_allow`, judged per permission request, with paths bound to the
   workspace; unasked calls judged after the fact, a violation cancelling the run.
3. The program's sandbox and network allowlist, which hold even when the agent does
   not ask.
4. Deterministic `post` gates, a commit, and a `wait` for a human before a separate
   task publishes. The agent never publishes and never holds a deploy credential;
   `mcp_servers` grants named ops through the bridge, and never a connector that sends
   or deploys on its own. A gate runs as the daemon in a directory the agent wrote, so
   the daemon takes nothing executable from it that the operator did not name: git
   hooks and `core.fsmonitor` are off for every git the daemon runs there and for the
   cleanup of the workspace, and a replaced `.git` pointer fails the run before the
   gates. A gate whose command executes project code by design (`npm test`) runs what
   the agent left; the documentation tells the operator to sandbox such gates when the
   agent works on untrusted content.
5. Hard stops: `max_tool_calls`, `budget.max_usd`, the task `timeout`, the daily cap.

Inbound content (mail, chat, webhook bodies, tickets) is untrusted: it enters prompts
as data in a delimited block and the system prompt says so, and it enters `decide` as
`state`, never as a question. The capability surface, not the prompt, is what limits
damage.

## Invariants a change must keep

- Nothing that runs as the daemon's uid executes untrusted content outside a sandbox.
- A secret value reaches exactly the process or call that named it, once, and is never
  written to the store, a log, an event, a transcript or an error message. No child of
  the daemon inherits the daemon's environment unfiltered.
- The protected set stays masked in every sandbox; a new daemon file that holds state
  or a credential is added to `protectedPaths()`.
- Only `acp` manifests take `sandbox`; `config` is refused on them; no `acp` connector
  gets the core socket.
- A wildcard allowlist entry never resolves to a non-public address; an added entry
  grammar keeps that rule.
- The API gains no secrets endpoint and no authentication substitute for the uid
  boundary.
