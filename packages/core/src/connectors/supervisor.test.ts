import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectorConfig } from '../config/connector.js';
import { ConnectorManifest } from '../config/connector.js';
import { createLogger } from '../log.js';
import { staticSecrets } from '../secrets/secrets.js';
import {
  ConnectorDownError,
  ConnectorOpError,
  ConnectorSupervisor,
  toolResultToJson,
} from './supervisor.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;

function manifest(over: Record<string, unknown> = {}): ConnectorConfig {
  return {
    ...ConnectorManifest.parse({
      name: 'fake',
      exec: ['node', `${FIXTURES}fake-mcp.ts`],
      restart: { base: '20ms', max: '100ms' },
      ...over,
    }),
    file: '/x/connectors.d/fake.yaml',
  };
}

let sup: ConnectorSupervisor | undefined;
let lines: Record<string, unknown>[];

function make(
  manifests: ConnectorConfig[],
  secrets: Record<string, string> = {},
): ConnectorSupervisor {
  lines = [];
  sup = new ConnectorSupervisor({
    manifests,
    socketPath: '/tmp/oa-test.sock',
    secrets: staticSecrets(secrets),
    log: createLogger({
      level: 'debug',
      sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    env: { PATH: process.env.PATH ?? '', FAKE_EXTRA: 'from-base' },
  });
  return sup;
}

afterEach(async () => {
  await sup?.stop();
  sup = undefined;
});

const signal = (): AbortSignal => new AbortController().signal;

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('ConnectorSupervisor', () => {
  it('spawns an MCP connector with the documented env, calls ops and maps results', async () => {
    const s = make(
      [
        manifest({
          config: { token: '${secrets.tok}', n: 2 },
          env: { FAKE_EXTRA: '${secrets.tok}-x' },
        }),
      ],
      { tok: 'sekrit' },
    );
    await s.start();
    expect(s.status()).toMatchObject([{ name: 'fake', state: 'up', restarts: 0 }]);
    expect(s.names()).toEqual(['fake']);

    await expect(s.call('fake', 'env', {}, { signal: signal() })).resolves.toEqual({
      name: 'fake',
      socket: '/tmp/oa-test.sock',
      config: { token: 'sekrit', n: 2 },
      extra: 'sekrit-x',
    });
    await expect(
      s.call('fake', 'echo', { value: { a: [1, 'b'] } }, { signal: signal() }),
    ).resolves.toEqual({ echoed: { a: [1, 'b'] } });
    await expect(s.call('fake', 'text', {}, { signal: signal() })).resolves.toBe(
      'plain text, not JSON',
    );
    await expect(s.call('fake', 'fail', { message: 'nope' }, { signal: signal() })).rejects.toThrow(
      ConnectorOpError,
    );
    await expect(s.call('fake', 'fail', { message: 'nope' }, { signal: signal() })).rejects.toThrow(
      'fake.fail: nope',
    );
    await expect(s.call('nope', 'echo', {}, { signal: signal() })).rejects.toThrow(
      'unknown connector',
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'connector.output',
        connector: 'fake',
        line: 'fake-mcp fake starting',
      }),
    );
    // The secret value stays out of the log.
    expect(JSON.stringify(lines)).not.toContain('sekrit');
  });

  it('enforces the manifest op allowlist and times out slow ops', async () => {
    const s = make([manifest({ ops: ['echo', 'slow'] })]);
    await s.start();
    await expect(s.call('fake', 'env', {}, { signal: signal() })).rejects.toThrow(
      /not in the manifest/,
    );
    await expect(
      s.call('fake', 'slow', { ms: 2000 }, { signal: signal(), timeoutMs: 100 }),
    ).rejects.toThrow(/timed out|timeout/i);
    const controller = new AbortController();
    const p = s.call('fake', 'slow', { ms: 2000 }, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow();
  });

  it('restarts a crashed connector with backoff and reports it down meanwhile', async () => {
    const s = make([manifest()]);
    await s.start();
    await expect(s.call('fake', 'crash', {}, { signal: signal() })).resolves.toEqual({
      crashing: true,
    });
    await until(() => s.status()[0]?.state === 'down');
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).rejects.toThrow(
      ConnectorDownError,
    );
    await until(() => s.status()[0]?.state === 'up');
    expect(s.status()[0]).toMatchObject({ state: 'up', restarts: 1 });
    await expect(s.call('fake', 'echo', { value: 1 }, { signal: signal() })).resolves.toEqual({
      echoed: 1,
    });
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['connector.exited', 'connector.restart_scheduled', 'connector.up']),
    );
  });

  it('keeps retrying a connector that cannot start, without a secret it needs', async () => {
    const s = make([manifest({ config: { t: '${secrets.missing}' } })]);
    await s.start();
    expect(s.status()[0]).toMatchObject({
      state: 'down',
      error: expect.stringMatching(/missing/) as string,
    });
    await until(() => (s.status()[0]?.restarts ?? 0) >= 2);
    const bad = make([manifest({ name: 'nope', exec: ['/nonexistent/binary'] })]);
    await bad.start();
    expect(bad.status()[0]).toMatchObject({ name: 'nope', state: 'down' });
    await bad.stop();
  });

  it('runs a transport: none connector as a plain process and refuses ops on it', async () => {
    const s = make([
      manifest({ name: 'plain', transport: 'none', exec: ['node', `${FIXTURES}fake-plain.ts`] }),
    ]);
    await s.start();
    expect(s.status()[0]).toMatchObject({ name: 'plain', state: 'up' });
    expect(s.status()[0]?.pid).toEqual(expect.any(Number));
    await expect(s.call('plain', 'x', {}, { signal: signal() })).rejects.toThrow(/serves no ops/);
    await until(() =>
      lines.some((l) => l.msg === 'connector.output' && l.line === 'fake-plain plain up'),
    );
    await s.stop();
    expect(s.status()[0]?.state).toBe('stopped');
  });
});

describe('toolResultToJson', () => {
  it('prefers structuredContent, parses JSON text, keeps plain text, joins several', () => {
    expect(toolResultToJson('c', 'o', { structuredContent: { a: 1 }, content: [] })).toEqual({
      a: 1,
    });
    expect(toolResultToJson('c', 'o', { content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({
      a: 1,
    });
    expect(toolResultToJson('c', 'o', { content: [{ type: 'text', text: 'hi' }] })).toBe('hi');
    expect(
      toolResultToJson('c', 'o', {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toEqual(['a', 'b']);
    expect(toolResultToJson('c', 'o', { content: [] })).toBeNull();
    expect(() =>
      toolResultToJson('c', 'o', { isError: true, content: [{ type: 'text', text: 'bad' }] }),
    ).toThrow('c.o: bad');
  });
});
