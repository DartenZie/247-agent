import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SocketClientTransport } from './socket-transport.js';

let dir: string;
let server: Server | undefined;

beforeEach(() => {
  // Short: Unix socket paths are limited to ~104 bytes on macOS.
  dir = mkdtempSync(join(tmpdir(), 'oa-sock-'));
});

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s !== undefined) {
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A unit socket that runs `onConnection` for the core's connection. */
async function listen(onConnection: (socket: Socket) => void): Promise<string> {
  const path = join(dir, 'unit.sock');
  const s = createServer(onConnection);
  server = s;
  await new Promise<void>((resolve) => s.listen(path, resolve));
  return path;
}

describe('SocketClientTransport', () => {
  it('fails the connection, not the process, when the connector sends more than the buffer holds', async () => {
    const path = await listen((socket) => {
      socket.on('error', () => undefined);
      // 11 MB without a newline: over the 10 MB read buffer.
      socket.write(Buffer.alloc(11 * 1024 * 1024, 'a'));
    });
    const transport = new SocketClientTransport(path);
    const errors: Error[] = [];
    transport.onerror = (err) => errors.push(err);
    const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
    await transport.start();

    await closed;
    expect(errors.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/exceeded maximum size/),
    );
    await expect(transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })).rejects.toThrow(
      /not connected/,
    );
  });
});
