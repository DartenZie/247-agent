import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Core } from '../core.js';
import { createLogger } from '../log.js';
import { Metrics } from '../metrics.js';
import { createApiServer, type ApiServer } from './server.js';

let dir: string;
let server: ApiServer;

let lines: string[];

beforeEach(async () => {
  lines = [];
  dir = mkdtempSync(join(tmpdir(), 'oa-api-'));
  server = createApiServer({
    // The oversized-body path answers before routing, so only the metrics are touched.
    core: { metrics: new Metrics() } as unknown as Core,
    clock: { now: () => new Date() },
    startedAt: new Date(),
    configFile: 'agent.yaml',
    log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }),
    socketPath: join(dir, 's.sock'),
    maxBodyBytes: 1024,
  });
  await server.listen();
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Settles on the request's close, so every client error is seen here, not after the test.
 * A client error before a complete response rejects: that is the #76 bug. On Linux the
 * client socket can also report EPIPE after the whole body was sent and the whole
 * response read, when the server closes the connection. The response then stands.
 */
function post(body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let result: { status: number; text: string } | undefined;
    const req = request(
      { socketPath: server.socketPath, method: 'POST', path: '/v1/events', agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          result = { status: res.statusCode ?? 0, text };
        });
      },
    );
    req.on('error', (err: Error) => {
      if (result !== undefined) {
        resolve(result);
        return;
      }
      // Says how far the body got and what the server logged, so a failure shows its cause.
      const detail = { bodyBytes: Buffer.byteLength(body), server: lines };
      reject(new Error(`${err.message}: ${JSON.stringify(detail)}`, { cause: err }));
    });
    req.on('close', () => {
      if (result === undefined) {
        reject(new Error('the connection closed without a complete response'));
      } else {
        resolve(result);
      }
    });
    req.end(body);
  });
}

describe('api server', () => {
  it('answers 413 naming the limit when the body is too large (#76)', async () => {
    const big = JSON.stringify({ type: 'x.y', payload: { data: 'a'.repeat(2 * 1024 * 1024) } });
    expect(await post(big)).toEqual({
      status: 413,
      text: '{"error":"request body exceeds 1024 bytes"}',
    });
  });

  it('reads a body of exactly the limit, and refuses one byte more', async () => {
    // Not JSON, so the server answers 400 after reading it and never reaches a route.
    expect(await post('a'.repeat(1024))).toMatchObject({ status: 400 });
    expect(await post('a'.repeat(1025))).toMatchObject({ status: 413 });
  });
});
