# Connector smoke rig

The chat, email, ftp and webhook connectors against real servers: a daemon on the real
connector programs, every op called through `oa run`, every event read back from the
daemon, the results checked, then the servers torn down. It is not part of `npm test`,
which never touches the network. Run it when you change one of these connectors, bump one
of their protocol libraries, or touch the supervisor or the connector action.

```
npm run build
npm run smoke:connectors              # every connector with a test/smoke/smoke.mjs
npm run smoke:connectors -- ftp       # only the named ones
npm run smoke:connectors -- --keep email   # leave the servers running afterwards
```

It needs podman with a compose provider (`podman compose` runs docker-compose or
podman-compose) for the connectors that have servers; webhook alone needs none. The first
run pulls the images and builds atmoz/sftp, so it takes a few minutes; after that a full
run of all four takes about two minutes. Every port is bound to 127.0.0.1; the ones in use
are listed at the top of each `compose.yaml`.

## What runs

**chat** (`connectors/chat/test/smoke/`): the Matrix backend against Synapse (the
reference homeserver) with open registration and no rate limits (`homeserver.yaml`).
Before the daemon starts, the module registers a `bot` and a `human`, the human makes two
rooms (`#smoke`, `#smoke-side`) and invites the bot, posts a message the connector must
skip (`initial: none`), and the bot's access token becomes the connector's `token`. Then
the module is the human: `send` plain, with `parse_mode: HTML`, with `reply_to`, and to
the side room by alias and by id, each read back from the room; refusals for a room not
allowed, a Telegram-style `reply_to` and eleven options. Its own messages become
`chat.message` events (text, `from` with the display name, `reply_to`, the reply fallback
stripped, the side room's id), while a notice, an edit and the history are not delivered.
`ask` lists the options with keycaps and reacts with them; a tap on `2️⃣`, a text reply
(`approve`) and a `2` in the question's thread each become one `chat.reply` with the
`correlation_id`, confirmed by the bot's `Recorded: …` notice; a reply to an answered
question is an ordinary message and the question is answered once. Last, `oa connector
restart`: nothing is replayed (the `since` cursor is in the core) and a question asked
before the restart is still answerable (so is `pending`). Telegram has no server one can
run, so that backend stays on the unit tests' fake Bot API.

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

**webhook** (`connectors/webhook/test/smoke/`): no servers, the connector is one. The
module sends real requests to two listeners, a TCP port with every `verify` kind and a
Unix socket with `trust_proxy`, and checks each where it lands: the event in the daemon
and, for a push to `main`, the run of the task it triggers (`${event.payload.body.after}`
rendered into the shell command). The `github` route takes GitHub's documented test vector
(their secret, body and signature), so the check is proven against GitHub's own numbers;
then a signed push (202), the same `X-GitHub-Delivery` again (200, `duplicate: true`, one
event), a push to another branch (an event but no run), and the refusals: wrong, missing
or `sha1=` signature (401), no `X-GitHub-Event` (400), invalid JSON (400), over `max_body`
(413), an unknown path (404), the wrong method (405 with `Allow`). A Bearer token with a
form body and a query string, `X-Gitlab-Token` with `Push Hook` folded into
`gitlab.push_hook`, an `hmac` route with sha1/base64/`v1=` and a binary body on PUT,
`verify: none` on a GET with no body. On the socket (mode `0600`): a bare token in
`X-Api-Key`, `remote` from `X-Forwarded-For` or `null` without it. No payload carries the
signature or token header, `authorization` or a `drop_headers` header.

GreenMail has no STARTTLS, so Dovecot (`dovecot.conf`) listens on 31143, 31110 and 31587
with `ssl = required` and proxies each login to GreenMail with the client's credentials:
mail sent through either front lands in the same mailboxes, and a session that logs in
through Dovecot was upgraded first.

Last, with the daemon stopped, it scans every run record and every file the daemon wrote
under `.state/` (the whole database with its WAL, so every event, run and state row, the
daemon's log, which carries the connectors' stderr, and the sync trees) for the servers'
passwords, the Matrix token and the webhook secrets, which reach the connectors only as
`${secrets.<name>}` from the env backend.

A connector module that throws (a changed result shape, a daemon that died) is a FAIL of
that module; the other modules and the scan still run. The last line is
`RESULT: PASS|FAIL|ERROR smoke:connectors: …`. Exit codes:

| exit | meaning |
| ---- | ------- |
| 0    | every check passed |
| 1    | a check failed: a regression until shown otherwise |
| 2    | the rig could not start: bad argument, missing build, no podman or compose provider, a server that never came up, or another run holds the lock |
| 130  | interrupted; the daemon and the servers were stopped |

One run at a time per host: the container names and ports are global, so a run takes a
lock (`$TMPDIR/oa-smoke-connectors.lock`) and a second one, from any checkout, exits 2
naming the holder. If a run is killed outright (SIGKILL, a tool timeout), its daemon and
servers keep running; the next run stops the daemon (`.state/daemon.pid`) and recreates
the servers. The rig warns when the Node running it is not the major in `.node-version`.
Don't run it next to `test:linux` on a small podman machine: together they can exhaust its
memory.

## How it fits together

`run.mjs` imports `connectors/<name>/test/smoke/smoke.mjs` for each connector. The module
exports `ports` (a number is a port that greets once the servers are up, a string an HTTP
URL that answers 2xx), `setup(rig)`, optionally `prepare(rig)`, and `run(rig)`. `setup`
declares connector manifests (`rig.connector`), the secrets they use (`rig.secret`), one
manual task per op shape (`rig.op(task, connector, op, fields)`: the task passes
`event.payload.<field>` for each field) and any other task as written in a tasks file
(`rig.task`). `run.mjs` then runs `podman compose -p oa-smoke-<name> up -d` for each
connector with a `compose.yaml`, waits for the ports and calls `prepare`, which provisions
what the connectors need before they start (users, rooms, a token: it may add secrets),
writes `.state/agent.yaml` and `.state/tasks.yaml`, validates them, starts the daemon and
calls `run`, which drives the tasks with `rig.call(task, payload)` (`oa run --event -
--wait`), reads events with `rig.events(type)` and runs with `rig.runs(task)`, restarts a
connector with `rig.restart(name)`, and records `rig.check`, `rig.succeeded` and
`rig.failed`. A payload must carry exactly the declared fields: a missing one would render
as null, which the op's schema rejects.

Everything the daemon writes stays in `.state/` (gitignored, recreated per run):
`agent.yaml`, `tasks.yaml`, the database, `daemon.log`, and each connector's scratch
directory (the ftp `sync` trees). With `--keep` the containers stay up for poking at by
hand, and the run prints the `podman compose … down -v` that removes them.

Adding a connector: a `test/smoke/smoke.mjs` in its directory, plus a
`test/smoke/compose.yaml` when it needs servers; nothing in `run.mjs`. GitHub and Jira have
no server one can run in a container, so those two connectors have no smoke run; their
ops are covered by unit tests against a fake API.

Found by this rig so far:

- IMAP ignored `starttls: true`: imapflow upgrades only when the server offers STARTTLS
  unless `doSTARTTLS` is set, so on a server without it the connector logged in in clear
  text.
- POP3 over TLS (implicit or STLS) failed when `host` was an IP address: Node refuses an IP
  as the TLS `servername`.
