# (S)FTP connector

Files inside one remote directory over SFTP, FTP or FTPS: eight ops (`list`, `stat`,
`read`, `write`, `delete`, `rename`, `mkdir`, `sync`), every path confined to the
configured `root`, no events, no state. How to configure and use it, every `config` key
and op: [`docs/connectors/ftp.md`](../../docs/connectors/ftp.md). Example manifest:
[`docs/examples/connectors.d/ftp.yaml`](../../docs/examples/connectors.d/ftp.yaml).

## Development

```
connectors/ftp/src/
  config.ts   zod schema, port defaults per protocol, root normalisation, local_roots
  paths.ts    confinement: resolveRemote(root, input) is the only place a remote path is interpreted
  ops.ts      the eight ops on the FileClient interface; one connection per call; sync walks the local tree
  sftp.ts     ssh2-sftp-client adapter behind a narrow SftpLib interface; host key pinning
  ftp.ts      basic-ftp adapter behind a narrow FtpLib interface (FTP and FTPS)
  types.ts    FileClient, FileEntry, FtpOpError and its codes (not_found, too_large, exists, path), op shapes
  main.ts     runConnector: the op definitions (zod inputs); no connection at start
```

Tests run without the network: `ops.test.ts` drives every op against an in-memory
`FileClient`; `sftp.test.ts` and `ftp.test.ts` inject fake library objects through the
factories and assert the calls, option mapping and error handling. The wire is covered by
the smoke rig against real servers (atmoz/sftp built at a pinned commit, vsftpd in plain
FTP and in forced FTPS):

```
npm run smoke:connectors -- ftp        # test/smoke/compose.yaml + smoke.mjs
```

To try one server by hand:

```
docker run --rm -p 2222:22 atmoz/sftp foo:pass:1001
OA_CORE_SOCKET=/tmp/x.sock OA_CONNECTOR_NAME=ftp \
OA_CONFIG_JSON='{"protocol":"sftp","host":"127.0.0.1","port":2222,"user":"foo","password":"pass","root":"upload"}' \
bin/247-agent-connector-ftp
```

then send MCP JSON-RPC on stdin (`initialize`, then `tools/call` with
`{"name":"list","arguments":{}}`), or point a local `agent.yaml` at the built connector
and use `oa run … --wait`. Things worth checking by hand: `../x` is refused before any
connection, a file over `max_bytes` fails with `too_large`, and `write` with
`parents: true` into a new directory works on FTP (where `ensureDir` changes the working
directory, which the adapter restores).

`packages/core/test/fixtures/fake-ftp.ts` is the fake for the core's integration test and
for trying task files without a server: it serves the same eight ops over the files
listed in the manifest's `config.files`. `examples/inbox-import.yaml` is a complete
deterministic import workflow.

```
npm run build
node packages/cli/dist/main.js validate docs/examples/connectors.d/ftp.yaml connectors/ftp/examples/inbox-import.yaml
```
