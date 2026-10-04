# (S)FTP connector

Files inside one remote directory over SFTP, FTP or FTPS. An ops-only connector: it emits
nothing by itself, and every op opens one connection, does its work and closes it, so the
process stays stateless. Every path a task passes is relative to the configured `root`
and confined to it; `..`, absolute paths and backslashes are refused before a connection
is opened. `sync` is the one op that reads the local disk: a directory tree under a
manifest-listed `local_roots` entry, uploaded as a whole (a built site, a report folder).

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/ftp.yaml
```

## Manifest

```yaml
name: ftp
exec: ["247-agent-connector-ftp"]
transport: stdio
ops: [list, stat, read, write, delete, rename, mkdir, sync]
config:
  protocol: sftp                        # sftp (default) | ftp | ftps
  host: sftp.example.com
  port: 22                              # default: 22 sftp, 21 ftp/ftps, 990 ftps with tls: implicit
  user: "${secrets.ftp_user}"           # required for sftp; ftp/ftps default to anonymous
  password: "${secrets.ftp_pass}"       # sftp needs password or private_key
  private_key: "${secrets.ftp_key}"     # sftp only: PEM/OpenSSH text; optional passphrase
  passphrase: "${secrets.ftp_key_pass}"
  host_key_fingerprint: "SHA256:…"      # sftp only: pin the server key (ssh-keygen -lf format or hex)
  tls: explicit                         # ftps only: explicit (AUTH TLS) | implicit (TLS from byte one)
  reject_unauthorized: true             # ftps: verify the server certificate
  root: /srv/exchange                   # every path is relative to this; default "." (login dir)
  max_bytes: 1000000                    # cap for read results and write payloads
  list_limit: 1000                      # max entries one list returns
  timeout: 30000                        # connect and command timeout, ms
  local_roots: [/var/lib/247-agent/repos/site/dist]   # local directories `sync` may upload from; empty (default) disables sync
```

Credentials come from the secrets backend through `${secrets.<name>}`; the connector never
logs them. A multi-line private key fits the `file` backend as a YAML block scalar.

### Security

- The manifest's `ops` list is the boundary. Give an agent-facing copy of the manifest
  only `[list, stat, read]`; keep `write`, `delete` and `rename` on the manifest that
  deterministic tasks use.
- `root` is enforced by the connector, not by the server. A chrooted account on the server
  is still the stronger guarantee; use both.
- Without `host_key_fingerprint` an SFTP connection accepts any host key. Set it for a
  server that holds anything sensitive: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
  prints the value.
- `max_bytes` bounds memory: `read` refuses a file larger than that before the transfer
  when the listing knows the size. FTP cannot abort a transfer half-way, so on a server
  whose listing hides sizes the file is downloaded fully and then refused. `sync` streams
  files from disk and is not capped.
- `local_roots` is the only way the connector reads the local disk. Leave it empty on a
  manifest that agents or inbound content can reach; list exactly the build output a
  deterministic publishing task uploads. Symlinks are resolved before the check and
  never followed inside the tree.

## Ops

All paths are relative to `root`; `.` or an empty string is the root itself. Results carry
the same relative paths, so `${result.entries[0].path}` can be fed straight back into
`read`. Every op fails the calling run without retry on a bad path, a missing file or a
size over `max_bytes`.

### `list({ path?, limit? })` → `{ path, entries, truncated }`

Entries of a directory (default: the root), sorted by name, at most `min(limit, list_limit)`.

```json
{ "path": "incoming", "truncated": false,
  "entries": [
    { "name": "a.csv", "path": "incoming/a.csv", "type": "file", "size": 1234, "mtime": "2026-06-01T08:00:00.000Z" },
    { "name": "sub",   "path": "incoming/sub",   "type": "dir",  "size": 0,    "mtime": null } ] }
```

`type` is `file`, `dir` or `symlink`. `mtime` is null on FTP servers without MLSD.

### `stat({ path })` → `{ path, exists, name?, type?, size?, mtime? }`

`{ "path": "x", "exists": false }` for a missing path, otherwise `exists: true` plus the
entry fields above.

### `read({ path, encoding? })` → `{ path, content, encoding, size }`

`encoding` is `utf8` (default) or `base64`; use `base64` for binary data, utf8 decoding
is lossy on it. Fails with `not_found`, `path` (a directory) or `too_large`.

### `write({ path, content, encoding?, parents?, overwrite? })` → `{ path, size }`

Creates or overwrites one file from `content` (utf8 or base64). `parents` (default true)
creates missing directories first; `overwrite: false` fails with `exists` when the file is
there. Content only, never a local file path.

### `delete({ path, recursive?, missing_ok? })` → `{ path, deleted, type }`

Removes a file or symlink, or a directory (`recursive: true` for a non-empty one). A
missing path fails with `not_found` unless `missing_ok: true`, which returns
`deleted: false`. The root itself is never deleted.

### `rename({ from, to, parents? })` → `{ from, to }`

Moves or renames inside the root; `parents: true` creates the target directory first.

### `mkdir({ path })` → `{ path }`

`mkdir -p`: creates parents, succeeds when the directory exists.

### `sync({ local, remote?, prune? })` → `{ local, remote, uploaded, bytes, pruned }`

Uploads every regular file below the local directory `local` (absolute, inside a
`local_roots` entry) to the remote directory `remote` (default: the root), creating
directories as needed, over one connection. Symlinks and special files are skipped.
`prune: true` then removes remote files and directories under `remote` that the local
tree lacks, so the remote directory mirrors the local one; nothing outside `remote` is
touched. `uploaded` and `pruned` list relative paths. Fails with `path` when `sync` is
disabled (`local_roots` empty), `local` is relative, a file, or outside the roots, or a
local name would escape the remote root; `not_found` when `local` does not exist.
Every file is re-uploaded on every call: there is no change detection, which keeps the
op stateless and correct when the remote was edited by hand.

```yaml
- name: publish_site
  trigger: { kind: event, type: site.built }
  action:
    kind: connector
    connector: ftp
    op: sync
    args: { local: /var/lib/247-agent/repos/site/dist, remote: ".", prune: true }
```

## Examples

`examples/inbox-import.yaml` polls `incoming/` with `list`, fans each file out as an
`ftp.file_seen` event (deduplicated on path, size and mtime), then reads it and moves it
to `processed/`. Note that `each` carries the JMESPath filter `[?type == 'file']`: an emit
rule's `when` runs once per rule, not per item.

Publishing a generated file is one task:

```yaml
- name: publish_report
  trigger: { kind: event, type: report.ready }
  action:
    kind: connector
    connector: ftp
    op: write
    args: { path: "reports/${event.payload.date}.csv", content: "${event.payload.csv}" }
```

The reference workflow (`docs/examples/website-updates.yaml`) still deploys with `lftp` in
a shell step because it mirrors a whole build directory; for single files a `connector`
task like the one above keeps the credentials out of shell environments.

## Development

```
connectors/ftp/src/
  config.ts   zod schema, port defaults per protocol, root normalisation
  paths.ts    confinement: resolveRemote(root, input) is the only place a path is interpreted
  ops.ts      the seven ops on the FileClient interface; one connection per call
  sftp.ts     ssh2-sftp-client adapter behind a narrow SftpLib interface
  ftp.ts      basic-ftp adapter behind a narrow FtpLib interface
  types.ts    FileClient, FileEntry, FtpOpError, op shapes
```

Tests run without the network: `ops.test.ts` drives every op against an in-memory
`FileClient`; `sftp.test.ts` and `ftp.test.ts` inject fake library objects through the
factories and assert the calls, option mapping and error handling. Neither a real SFTP
server (ssh2's `Server` needs hand-written request handlers) nor a fake FTP server (PASV
and TLS choreography) is worth the code; the wire is covered by the smoke run against real
servers in containers (podman), `test/smoke/compose.yaml` (OpenSSH via atmoz/sftp, vsftpd
plain and with forced FTPS) and `test/smoke/smoke.mjs`:

```
npm run build
npm run smoke:connectors -- ftp
```

It runs every op on all three protocols through a daemon, including `write` with
`parents` into a new directory on FTP (where `ensureDir` changes the working directory,
which the adapter restores), `max_bytes` on `write` and `read`, `sync` with `prune`, and
`../x` refused before any connection. See `test/smoke/connectors/README.md`.

`packages/core/test/fixtures/fake-ftp.ts` is the fake for the core's integration test
and for trying task files without a server: it serves the same seven ops over the files
listed in the manifest's `config.files`.
