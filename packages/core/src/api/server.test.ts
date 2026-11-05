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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oa-api-'));
  server = createApiServer({
    // The oversized-body path answers before routing, so only the metrics are touched.
    core: { metrics: new Metrics() } as unknown as Core,
    clock: { now: () => new Date() },
    startedAt: new Date(),
    configFile: 'agent.yaml',
    log: createLogger({ level: 'error', sink: () => undefined }),
    socketPath: join(dir, 's.sock'),
    maxBodyBytes: 1024,
  });
  await server.listen();
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: server.socketPath, method: 'POST', path: '/v1/events' },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('api server', () => {
  it('answers 413 naming the limit when the body is too large (#76)', async () => {
    const big = JSON.stringify({ type: 'x.y', payload: { data: 'a'.repeat(2 * 1024 * 1024) } });
    await expect(post(big)).resolves.toEqual({
      status: 413,
      body: { error: 'request body exceeds 1024 bytes' },
    });
  });
});
