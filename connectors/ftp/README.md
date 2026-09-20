# (S)FTP connector

Files inside one remote directory over SFTP, FTP or FTPS. An ops-only connector: it emits
nothing by itself, and every op opens one connection, does its work and closes it, so the
process stays stateless. Every path a task passes is relative to the configured `root`
and confined to it; `..`, absolute paths and backslashes are refused before a connection
is opened.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/ftp.yaml
```

## Manifest

```yaml
name: ftp
exec: ["node", "connectors/ftp/dist/main.js"]
transport: stdio
ops: [list, stat, read, write, delete, rename, mkdir]
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
  whose listing hides sizes the file is downloaded fully and then refused.

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
and TLS choreography) is worth the code; the wire is covered by a manual check:

```
docker run --rm -p 2222:22 atmoz/sftp foo:pass:1001
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=ftp \
OA_CONFIG_JSON='{"protocol":"sftp","host":"127.0.0.1","port":2222,"user":"foo","password":"pass","root":"upload"}' \
node connectors/ftp/dist/main.js
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with `{"name":"list","arguments":{}}`),
or point a local `agent.yaml` at the built connector and use `oa run … --wait`. For FTP,
`delfer/alpine-ftp-server` with `-e USERS="foo|pass" -e ADDRESS=127.0.0.1` and ports
21 and 21000-21010 does the same. Things worth checking by hand: `../x` is refused before
any connection, a file over `max_bytes` fails with `too_large`, and `write` with
`parents: true` into a new directory works on FTP (where `ensureDir` changes the working
directory, which the adapter restores).

`packages/core/test/fixtures/fake-ftp.ts` is the fake for the core's integration test
and for trying task files without a server: it serves the same seven ops over the files
listed in the manifest's `config.files`.
