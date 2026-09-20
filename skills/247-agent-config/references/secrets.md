# Secrets

Config references secrets **by name**: `${secrets.ftp_pass}` inside an action, or in a
connector manifest's `config`/`env`. The daemon resolves only the names a run or a
connector actually uses, at run time, from one backend. Values never reach the
database, the logs, an event payload, `emit` or `state_updates` (`oa validate`
rejects `secrets` there), and `${secrets}` as a whole is rejected.

| `secrets:` | Where a name `ftp_pass` comes from | Reload |
|---|---|---|
| `{ backend: env, prefix: OA_SECRET_ }` | Environment variable `OA_SECRET_FTP_PASS` (name upper-cased, prefix optional, default none) | daemon restart |
| `{ backend: file, path: secrets.yaml }` | Key `ftp_pass` in a YAML or JSON map, path relative to `agent.yaml`; mode 0600, owned by the service user | re-read on every resolve |
| `{ backend: systemd-credentials }` | File `$CREDENTIALS_DIRECTORY/ftp_pass`, provided by `LoadCredential=ftp_pass:/etc/credstore/ftp_pass` in the unit | service restart |

The secrets backend's own variables are removed from the `env` template scope, so a
task cannot read `${env.OA_SECRET_X}` around the rule.

## Which secrets a config needs

```
grep -rhoE 'secrets\.[a-z0-9_]+' agent.yaml tasks*.yaml tasks.d connectors.d 2>/dev/null | sort -u
```

Typical names: `anthropic_api_key` (for `llm`/`agent` runners), `imap_user`,
`imap_pass`, `chat_token`, `chat_id`, `ftp_pass`, `github_token`.

## Where secrets are allowed to flow

- Into a `shell` action's `env` or `cmd` (prefer `env`; argv is visible in `ps`).
- Into a `connector` manifest's `config`/`env`, rendered into `OA_CONFIG_JSON` for that
  process only.
- Never into an `agent` action: agents never hold deploy credentials. The publishing
  `shell` task holds them instead, and an approval gate sits in between when the change
  is high-impact.

## Rotating

Change the value at the backend, then restart (`env`, `systemd-credentials`) or do
nothing (`file`). Runs already in flight keep the value they resolved at start.
