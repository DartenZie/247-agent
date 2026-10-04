# A connector in its own systemd unit

Every connector runs as the daemon's child, as the daemon's user, by default. One that
needs more than the daemon has, or must hold a secret the daemon should not see, can run
in its own systemd unit instead. The daemon then talks to it over a socket, or just lists
it, and never resolves its secrets.

## When you need it

- A port below 1024, a device, or files another user owns: privileges the daemon's
  hardened unit does not have and should not get.
- A credential only this connector may read: its `LoadCredential=` lines go on its own
  unit, and the daemon's unit never names them.
- An isolation boundary: with `User=` in the drop-in the connector runs as its own user,
  and the daemon's state directory is hidden from it.

## The manifest

Add `managed_by: systemd` to a normal manifest:

```yaml
name: webhook
exec: ["247-agent-connector-webhook"]
transport: none
managed_by: systemd                 # the daemon does not spawn it
emits: [github.push, github.pull_request]
config:
  listen: { host: 0.0.0.0, port: 80 }   # a low port: needs CAP_NET_BIND_SERVICE
  routes:
    - path: /hooks/github
      event: github
      type_header: X-GitHub-Event
      dedup_header: X-GitHub-Delivery
      verify: { kind: github, secret: "${secrets.github_webhook_secret}" }
```

An agent program or the built-in poller cannot be `managed_by: systemd`: an agent program
is confined with `sandbox: bwrap` instead, and a poller has no process.

## The unit

The daemon ships a template unit, `247-agent-connector@.service`, installed next to its
own and never enabled by default. The instance name is the manifest's `name`. Give it its
privileges and credentials in a drop-in, then enable it and tell the daemon:

```sh
sudo systemctl edit 247-agent-connector@webhook
```

```ini
[Service]
User=247-agent-webhook
AmbientCapabilities=CAP_NET_BIND_SERVICE
LoadCredential=github_webhook_secret:/etc/credstore/github_webhook_secret
```

```sh
sudo systemctl enable --now 247-agent-connector@webhook
sudo oa reload                      # the daemon now lists it instead of spawning it
```

The unit runs `247-agent-connector-host <name>`, which reads the same `agent.yaml` and
manifest as the daemon, refuses a connector that is not marked `managed_by: systemd` (so
it can never run twice), resolves the connector's secrets from the unit's own backend,
and starts the program with exactly the environment the daemon would have given it.

> [!WARNING]
> Keep `Group=247-agent` in the drop-in even when you set `User=`. The group is how the
> connector reads `/etc/247-agent` and reaches the daemon's socket, which the daemon
> creates with mode `0660`, and how the daemon reaches the connector's socket.

With `secrets: { backend: systemd-credentials }` in `agent.yaml`, the connector's secrets
are the `LoadCredential=` lines on this unit. With the `env` backend they are
`OA_SECRET_…` variables in this unit's environment. Either way the daemon never resolves
them.

## The two cases

**Without ops** (`transport: none`, a webhook receiver or a bot that only emits): the host
runs the program for the life of the unit and exits with it, so `Restart=always` in the
unit stands in for the daemon's backoff. `oa connector list` shows it as `external` with
`unit=247-agent-connector@webhook`. `oa connector restart` answers that it runs in its own
unit and names the `systemctl restart` to use, which is also the only way a changed
manifest reaches it: `oa reload` logs `connector.unit_restart_needed`. Its log is in
`journalctl -u 247-agent-connector@webhook`.

**With ops** (`transport: stdio`): the host listens on a Unix socket, by default
`/run/247-agent-connector/<name>/mcp.sock` (the manifest's `socket:` field overrides it),
and the daemon connects to it instead of spawning the program, with the usual `restart`
backoff, `health` checks and `ops` allowlist. For each connection the host reads the
config and secrets again and starts a fresh process, so `oa connector restart`, which
reconnects, still picks up a rotated secret and a changed manifest. The connector shows
`down` with the hint `is 247-agent-connector@<name> running?` until the unit is up.

The unit is `PartOf=247-agent.service`: stopping or restarting the daemon does the same to
its connectors.

## Trying it by hand

Run the host yourself with the same config, with the connector's secrets in your own
environment:

```sh
247-agent-connector-host --config /etc/247-agent/agent.yaml webhook
```

For a connector with ops, point the manifest's `socket:` at a path you can write to; the
daemon always connects to the manifest's socket, so the host's own `--socket` flag is for
a host the daemon does not use. The host logs JSON lines on standard error, each tagged
with the connector's name, and the connector's own messages land there too.

Exit codes that matter when systemd shows the unit failing:

| Exit | Meaning |
|---|---|
| `1` | the host refused: an invalid `agent.yaml` or manifest, no such connector, a connector not marked `managed_by: systemd`, a secret that could not be resolved. The log line says which |
| `1` after the program ran | a `transport: none` program exited on its own, even cleanly, so that `Restart=always` starts it again |
| `127` | the program could not be started: `exec` names something not on `PATH` |
| `2` | a usage error: a wrong flag, or not exactly one connector name |
| `70` | an unexpected failure at start, such as a socket that could not be bound |

The connector's own non-zero exit code is passed through for a `transport: none` program
that died.
