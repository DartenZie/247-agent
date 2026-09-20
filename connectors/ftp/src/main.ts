/**
 * The (S)FTP connector: files inside one remote directory over SFTP, FTP or FTPS. Ops:
 * `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir`. Spawned by the core with
 * the manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '@247-agent/connector-sdk';

import { parseConfig } from './config.js';
import { connectFtp } from './ftp.js';
import { FileOps } from './ops.js';
import { connectSftp } from './sftp.js';

const encoding = z.enum(['utf8', 'base64']).optional();

await runConnector({
  version: '0.1.0',
  tools: (rt) => {
    const config = parseConfig(rt.env.config);
    rt.log(
      `ftp: ${config.protocol}://${config.host}:${String(config.port)} root=${config.root}` +
        (config.protocol === 'ftps' ? ` tls=${config.tls}` : ''),
    );
    const ops = new FileOps(
      config,
      rt.log,
      config.protocol === 'sftp' ? (c) => connectSftp(c) : (c) => connectFtp(c),
    );

    return [
      defineTool({
        name: 'list',
        description:
          'Entries of a directory (default: the root), sorted by name. Returns {path, entries: [{name, path, type, size, mtime}], truncated}.',
        input: { path: z.string().optional(), limit: z.number().int().min(1).optional() },
        handler: async (args) => (await ops.list(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'stat',
        description: 'Whether a path exists and what it is: {path, exists, type?, size?, mtime?}.',
        input: { path: z.string() },
        handler: async (args) => (await ops.stat(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'read',
        description:
          'The content of one file as utf8 (default) or base64. Fails when the file is larger than max_bytes.',
        input: { path: z.string(), encoding },
        handler: async (args) => (await ops.read(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'write',
        description:
          'Creates or overwrites one file from utf8 (default) or base64 content. Missing parent directories are created unless parents is false; overwrite: false fails when the file exists.',
        input: {
          path: z.string(),
          content: z.string(),
          encoding,
          parents: z.boolean().optional(),
          overwrite: z.boolean().optional(),
        },
        handler: async (args) => (await ops.write(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'delete',
        description:
          'Removes one file, or a directory (recursive: true for a non-empty one). missing_ok: true makes a missing path a no-op.',
        input: {
          path: z.string(),
          recursive: z.boolean().optional(),
          missing_ok: z.boolean().optional(),
        },
        handler: async (args) => (await ops.delete(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'rename',
        description:
          'Moves or renames a file or directory inside the root. parents: true creates the target directory first.',
        input: { from: z.string(), to: z.string(), parents: z.boolean().optional() },
        handler: async (args) => (await ops.rename(args)) as unknown as JsonValue,
      }),
      defineTool({
        name: 'mkdir',
        description: 'Creates a directory and its parents; succeeds when it already exists.',
        input: { path: z.string() },
        handler: async (args) => (await ops.mkdir(args)) as unknown as JsonValue,
      }),
    ];
  },
});
