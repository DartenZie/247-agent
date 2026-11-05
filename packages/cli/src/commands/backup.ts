import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ApiConnectionError, ApiError } from '@247-agent/core';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const BACKUP_USAGE = `usage: oa backup <file> [options]

Writes a consistent copy of the daemon's database to <file> while the daemon runs, with
SQLite's online backup API. The daemon copies the database next to itself and streams the
copy over the socket, so <file> is on the machine and in the directory you run oa from.
The file is created 0600; it holds every payload, result and transcript.

options:
  --force               replace <file> when it exists
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function backup(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { force: { type: 'boolean' }, socket: { type: 'string' } },
  });
  const [file, ...extra] = positionals;
  if (file === undefined || extra.length > 0) {
    throw new UsageError('backup takes exactly one file');
  }
  const replace = values.force === true;
  if (!replace && existsSync(file)) {
    io.err(`${file} already exists; use --force to replace it`);
    return EXIT.failed;
  }
  try {
    await client(values.socket).backup(resolve(file), { replace });
  } catch (err) {
    if (err instanceof ApiConnectionError || err instanceof ApiError) {
      return reportApiError(err, io);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      io.err(`${file} already exists; use --force to replace it`);
    } else {
      io.err(`cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return EXIT.failed;
  }
  io.out(`wrote ${file}`);
  return EXIT.ok;
}
