# Files over SFTP, FTP or FTPS

The ftp connector reads and writes files inside one directory on a remote server over
SFTP, FTP or FTPS. It is **ops-only**: it emits nothing, keeps no state, and opens one
connection per op. Every path a task passes is relative to the configured `root` and
confined to it: `..`, absolute paths and backslashes are refused before any connection is
opened. `sync` uploads a whole local directory, which is how a built site is published.

## Set it up

1. **Get an account on the server** with its own home or a dedicated directory. A
   chrooted account is the stronger guarantee; the connector's `root` is enforced on
   top of it, not instead of it.
2. **Store the credentials as secrets.** A password, or for SFTP a private key:

   ```sh
   OA_SECRET_FTP_USER=exchange
   OA_SECRET_FTP_PASS=…
   ```

   A multi-line private key fits the `file` secrets backend as a YAML block scalar.

3. **Pin the host key** for SFTP once you trust the server:
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server prints the
   `SHA256:…` value for `host_key_fingerprint`.
4. **Write the manifest** into `connectors.d/ftp.yaml` and `oa validate agent.yaml`.

## Manifest

```yaml
name: ftp
exec: ["247-agent-connector-ftp"]
transport: stdio
ops: [list, stat, read, write, delete, rename, mkdir, sync]
config:
  protocol: sftp                        # sftp (default) | ftp | ftps
  host: sftp.example.com
  port: 22                              # default: 22 sftp, 21 ftp and explicit ftps, 990 implicit ftps
  user: "${secrets.ftp_user}"           # required for sftp; ftp/ftps default to anonymous
  password: "${secrets.ftp_pass}"       # sftp needs password or private_key
  private_key: "${secrets.ftp_key}"     # sftp only: PEM or OpenSSH text
  passphrase: "${secrets.ftp_key_pass}" # sftp only, when the key has one
  host_key_fingerprint: "SHA256:…"      # sftp only: pin the server's key
  tls: explicit                         # ftps only: explicit (AUTH TLS) | implicit (TLS from byte one)
  reject_unauthorized: true             # ftps: verify the server certificate
  root: /srv/exchange                   # every path is relative to this; default "." (the login directory)
  max_bytes: 1000000                    # cap for read results and write payloads
  list_limit: 1000                      # most entries one list returns
  timeout: 30000                        # connect and command timeout, ms
  local_roots: [/var/lib/247-agent/repos/site/dist]   # local directories sync may upload from; empty disables sync
```

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `protocol` | `sftp` | `sftp`, `ftp` or `ftps` |
| `host` | required | the server |
| `port` | by protocol | 22 for sftp, 21 for ftp and explicit ftps, 990 for implicit ftps |
| `user` | required for sftp | ftp and ftps log in as `anonymous` with the password `guest` when unset |
| `password` | none | sftp needs `password` or `private_key` |
| `private_key` | none | sftp only; the key text |
| `passphrase` | none | sftp only |
| `host_key_fingerprint` | none | sftp only; `SHA256:<base64>` or hex. Without it any host key is accepted |
| `tls` | `explicit` | ftps only |
| `reject_unauthorized` | `true` | ftps certificate check |
| `root` | `.` | the directory every path is relative to and confined to |
| `max_bytes` | `1000000` | `read` refuses a larger file, `write` a larger payload |
| `list_limit` | `1000` | the most entries one `list` returns, 1 to 10000 |
| `timeout` | `30000` | connect and command timeout in milliseconds |
| `local_roots` | `[]` | absolute local directories `sync` may read from; empty means `sync` is disabled |

> [!WARNING]
> Without `host_key_fingerprint` an SFTP connection accepts any host key. Set it for a
> server that holds anything sensitive.

## Ops

All paths are relative to `root`; `.` or an empty string is the root itself. Results carry
the same relative paths, so `${result.entries[0].path}` feeds straight back into `read`.
A bad path, a missing file or a size over `max_bytes` fails the calling run without retry.

| Op | Arguments | Result |
|---|---|---|
| `list` | `path` (default the root), `limit` | `{ path, entries, truncated }`; entries sorted by name, at most the smaller of `limit` and `list_limit`. An entry is `{ name, path, type: file \| dir \| symlink, size, mtime }`; `mtime` is `null` on FTP servers without MLSD |
| `stat` | `path` | `{ path, exists: false }` or `{ exists: true, name, path, type, size, mtime }` |
| `read` | `path`, `encoding: utf8 \| base64` | `{ path, content, encoding, size }`. Use `base64` for binary data. Fails with `not_found`, `path` (a directory) or `too_large` |
| `write` | `path`, `content`, `encoding`, `parents` (default true), `overwrite` (default true) | `{ path, size }`. Content only, never a local file path. `overwrite: false` fails with `exists` |
| `delete` | `path`, `recursive`, `missing_ok` | `{ path, deleted, type }`. A non-empty directory needs `recursive: true`; the root is never deleted |
| `rename` | `from`, `to`, `parents` | `{ from, to }`. Moves inside the root; the root itself cannot be renamed |
| `mkdir` | `path` | `{ path }`. Creates parents; succeeds when the directory exists |
| `sync` | `local` (absolute, inside a `local_roots` entry), `remote` (default the root), `prune` | `{ local, remote, uploaded, bytes, pruned }` |

`sync` uploads every regular file below `local` to `remote` over one connection, creating
directories as needed; symlinks and special files are skipped. With `prune: true` it then
removes remote files and directories under `remote` that the local tree lacks, so the
remote mirrors the local directory; nothing outside `remote` is touched. Every file is
re-uploaded on every call: there is no change detection, which keeps the op stateless and
correct when the remote was edited by hand. `sync` is not capped by `max_bytes`.

> [!WARNING]
> `local_roots` is the only way this connector reads the local disk. Leave it empty on a
> manifest that agents or inbound content can reach, and list exactly the build output
> your publishing task uploads.

## Security

- The `ops` list is the boundary. Give an agent-facing copy of the manifest only
  `[list, stat, read]`; keep `write`, `delete`, `rename` and `sync` on the manifest your
  deterministic tasks use.
- `root` is enforced by the connector before any connection; a chrooted account on the
  server is still the stronger guarantee. Use both.
- `max_bytes` bounds memory. FTP cannot abort a transfer half-way, so on a server whose
  listing hides sizes a too-large file is downloaded fully and then refused.

## Tasks

Publish a built site, then import files a partner drops into `incoming/`:

```yaml
tasks:
  - name: publish_site
    trigger: { kind: event, type: site.built }
    action:
      kind: connector
      connector: ftp
      op: sync
      args: { local: /var/lib/247-agent/repos/site/dist, remote: ".", prune: true }

  - name: scan_incoming
    trigger: { kind: cron, schedule: "*/5 * * * *", overlap: skip }
    action:
      kind: connector
      connector: ftp
      op: list
      args: { path: incoming }
    emit:
      - type: ftp.file_seen
        each: "${result.entries[?type == 'file']}"
        dedup_key: "ftp:${item.path}:${item.size}:${item.mtime}"
        payload: ${item}

  - name: import_file
    trigger: { kind: event, type: ftp.file_seen }
    action:
      kind: sequence
      steps:
        - kind: connector
          connector: ftp
          op: read
          args: { path: "${event.payload.path}" }
        - kind: connector
          connector: ftp
          op: rename
          args: { from: "${event.payload.path}", to: "processed/${event.payload.name}", parents: true }
    emit:
      - type: ftp.file_imported
        payload:
          name: ${event.payload.name}
          content: ${result.steps[0].content}
```

> [!TIP]
> The filter `[?type == 'file']` lives in `each`, not in `when`: a rule's `when` runs once
> per rule, `each` decides per item. The dedup key on path, size and modification time
> means an unchanged file is never imported twice.

The complete import example is
[`inbox-import.yaml`](../../connectors/ftp/examples/inbox-import.yaml). For a single
generated file, `write` with `content` from the event is one task and keeps the
credentials out of any shell environment.
