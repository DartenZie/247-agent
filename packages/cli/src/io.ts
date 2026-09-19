import { readFileSync } from 'node:fs';

import { ApiClient, ApiConnectionError, ApiError, DEFAULT_SOCKET } from '@online-agent/core';

/** Where a command writes and reads, so tests can capture it. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin: () => Promise<string>;
}

export const processIo: Io = {
  out: (line) => {
    process.stdout.write(line + '\n');
  },
  err: (line) => {
    process.stderr.write(line + '\n');
  },
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  },
};

/** Exit codes: 0 ok, 1 the daemon or the run reported a failure, 2 usage. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** A usage error: message on stderr, exit 2. */
export class UsageError extends Error {}

/** `--socket` beats `OA_CORE_SOCKET` beats the systemd default. */
export function resolveSocket(flag: string | undefined): string {
  return flag ?? process.env.OA_CORE_SOCKET ?? DEFAULT_SOCKET;
}

export function client(socketFlag: string | undefined): ApiClient {
  return new ApiClient({ socketPath: resolveSocket(socketFlag) });
}

/** Reads a JSON document from a file or, for `-`, stdin. */
export async function readJson(source: string, io: Io): Promise<unknown> {
  let text: string;
  try {
    text = source === '-' ? await io.readStdin() : readFileSync(source, 'utf8');
  } catch (err) {
    throw new UsageError(
      `cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(
      `${source === '-' ? 'stdin' : source}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Turns a failed API call into stderr lines and an exit code. */
export function reportApiError(err: unknown, io: Io): number {
  if (err instanceof ApiConnectionError) {
    io.err(`${err.message}. Is online-agent-core running? Set --socket or OA_CORE_SOCKET.`);
    return EXIT.failed;
  }
  if (err instanceof ApiError) {
    io.err(`daemon: ${err.message}`);
    for (const issue of err.issues) {
      io.err(`  ${issue.path === '' ? '' : issue.path + ': '}${issue.message}`);
    }
    return err.status === 400 ? EXIT.usage : EXIT.failed;
  }
  throw err;
}
