# Connector smoke rig

The email and ftp connectors against real servers in containers: a daemon on the real
connector programs, every op called through `oa run`, the results checked, then the
servers torn down. It is not part of `npm test`, which never touches the network. Run it
when you change one of these connectors, bump one of their protocol libraries, or touch
the supervisor or the connector action.

```
npm run build
npm run smoke:connectors              # every connector with a test/smoke/compose.yaml
npm run smoke:connectors -- ftp       # only the named ones
npm run smoke:connectors -- --keep email   # leave the servers running afterwards
```

It needs podman with a compose provider (`podman compose` runs docker-compose or
podman-compose). The first run pulls the images and builds atmoz/sftp, so it takes a few
minutes; after that a full run of both takes about a minute and a half. Every port is
bound to 127.0.0.1; the ones in use are listed at the top of each `compose.yaml`.

## What runs

**email** (`connectors/email/test/smoke/`): GreenMail 2.1 serves IMAP, POP3 and SMTP in
plain text and with implicit TLS; Dovecot 2.4 sits in front of it as the STARTTLS proxy.
For each way in (IMAP and POP3, each plain, TLS and STARTTLS) a connector `send`s to its
own mailbox and `fetch_new`s it back, checking `initial: none`, the footer and the
cursor. On plain IMAP it also sends html with an attachment, threads a reply, runs
`mark_read` by uid and by message id (the flags are read back over a separate IMAP
session) and pages with `limit`. Refusals: no STARTTLS while `starttls` is on (IMAP, POP3,
SMTP), and a self-signed certificate while `reject_unauthorized` is on.

**ftp** (`connectors/ftp/test/smoke/`): atmoz/sftp, built from its repository at a pinned
commit because the published images are amd64 only; vsftpd in plain FTP; vsftpd forcing
explicit FTPS. For each of the three: `write` (utf8, base64, into a new directory,
`overwrite: false`), `list` (with `limit`), `stat`, `read`, `rename`, `mkdir`, `delete`;
`max_bytes` on `write`, and on `read` of a larger file put there by `sync`; `sync` with
and without `prune`, and from outside `local_roots`; `../x` refused by `read`, `write`,
`rename` and `sync`. A connector whose server is down refuses `../x` all the same, so the
refusal happens before any connection. Last, a self-signed FTPS certificate is refused.

GreenMail has no STARTTLS, so Dovecot (`dovecot.conf`) listens on 31143, 31110 and 31587
with `ssl = required` and proxies each login to GreenMail with the client's credentials:
mail sent through either front lands in the same mailboxes, and a session that logs in
through Dovecot was upgraded first.

Last, it scans every run record, the events and the daemon's log (which carries the
connectors' stderr) for the servers' passwords, which reach the connectors only as
`${secrets.<name>}` from the env backend. Exit 0: every check passed; 1: a check failed;
2: the rig did not start (bad argument, missing build, no podman, a server that never came
up).

## How it fits together

`run.mjs` imports `connectors/<name>/test/smoke/smoke.mjs` for each connector. The module
exports `ports` (where its servers greet once they are up), `setup(rig)` and `run(rig)`.
`setup` declares connector manifests (`rig.connector`), the secrets they use
(`rig.secret`) and one manual task per op shape (`rig.op(task, connector, op, fields)`:
the task passes `event.payload.<field>` for each field). `run.mjs` then writes
`.state/agent.yaml` and `.state/tasks.yaml`, validates them, runs `podman compose -p
oa-smoke-<name> up -d`, waits for the ports, starts the daemon and calls `run`, which
drives the tasks with `rig.call(task, payload)` (`oa run --event - --wait`) and records
`rig.check`, `rig.succeeded` and `rig.failed`. A payload must carry exactly the declared
fields: a missing one would render as null, which the op's schema rejects.

Everything the daemon writes stays in `.state/` (gitignored, recreated per run):
`agent.yaml`, `tasks.yaml`, the database, `daemon.log`, and each connector's scratch
directory (the ftp `sync` trees). With `--keep` the containers stay up for poking at by
hand, and the run prints the `podman compose … down -v` that removes them.

Adding a connector: a `test/smoke/compose.yaml` and a `test/smoke/smoke.mjs` in its
directory, nothing in `run.mjs`.

Found by this rig so far:

- IMAP ignored `starttls: true`: imapflow upgrades only when the server offers STARTTLS
  unless `doSTARTTLS` is set, so on a server without it the connector logged in in clear
  text.
- POP3 over TLS (implicit or STLS) failed when `host` was an IP address: Node refuses an IP
  as the TLS `servername`.
