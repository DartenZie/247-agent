import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorClients } from '../actions/types.js';
import { ApiClient } from '../api/client.js';
import { createBus, type EventBus } from '../bus/bus.js';
import { testEnv, type TestEnv } from '../bus/testing.js';
import { parseManifest, type ConnectorConfig } from '../config/connector.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createLogger } from '../log.js';
import { staticSecrets } from '../secrets/secrets.js';
import type { JsonValue } from '../store/types.js';
import { Poller, PollerConfig, SEEN_KEY } from './poller.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url).pathname;

function manifest(
  config: Record<string, unknown>,
  over: Record<string, unknown> = {},
): ConnectorConfig {
  const r = parseManifest(
    {
      name: 'prs',
      builtin: 'poller',
      config: {
        schedule: '* * * * *',
        connector: 'github',
        op: 'list_pull_requests',
        items: 'pull_requests',
        item_key: 'number',
        event: 'github.pr_opened',
        ...config,
      },
      ...over,
    },
    '/x/connectors.d/prs.yaml',
  );
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }
  return r.config;
}

interface Call {
  connector: string;
  op: string;
  args: Record<string, JsonValue>;
}

/** A fake target: `next` is what the next op call returns (or throws). */
function fakeClients(): ConnectorClients & {
  calls: Call[];
  next: JsonValue | Error | ((signal: AbortSignal) => Promise<JsonValue>);
} {
  const f = {
    calls: [] as Call[],
    next: null as JsonValue | Error | ((signal: AbortSignal) => Promise<JsonValue>),
    names: () => ['github'],
    call: async (
      connector: string,
      op: string,
      args: Record<string, JsonValue>,
      opts: { signal: AbortSignal },
    ) => {
      f.calls.push({ connector, op, args });
      if (f.next instanceof Error) {
        throw f.next;
      }
      if (typeof f.next === 'function') {
        return f.next(opts.signal);
      }
      return f.next;
    },
  };
  return f;
}

let env: TestEnv;
let bus: EventBus;
let clients: ReturnType<typeof fakeClients>;

beforeEach(() => {
  env = testEnv();
  bus = createBus({ store: env.store, clock: env.clock, log: env.log });
  clients = fakeClients();
});
afterEach(() => {
  env.close();
});

function poller(
  config: Record<string, unknown> = {},
  secrets: Record<string, string> = {},
): Poller {
  return new Poller({
    manifest: manifest(config),
    clients,
    store: env.store,
    bus,
    clock: env.clock,
    log: env.log,
    secrets: staticSecrets(secrets),
    env: { REPO: 'site' },
  });
}

const prs = (...numbers: number[]): JsonValue => ({
  pull_requests: numbers.map((n) => ({ number: n, title: `PR ${String(n)}` })),
});

const events = (): {
  type: string;
  source: string;
  dedup_key: string | null;
  payload: JsonValue;
}[] =>
  env.store.events
    .listAfter(0, 1000)
    .map(({ type, source, dedup_key, payload }) => ({ type, source, dedup_key, payload }));

const seen = (): JsonValue | undefined => env.store.state.get('prs', SEEN_KEY)?.value;

describe('PollerConfig', () => {
  it('validates schedule, tz, expressions and the event type', () => {
    const base = { schedule: '* * * * *', connector: 'x', op: 'o', item_key: 'id', event: 'a.b' };
    expect(PollerConfig.safeParse(base).success).toBe(true);
    const bad = (over: Record<string, unknown>): string[] => {
      const r = PollerConfig.safeParse({ ...base, ...over });
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(bad({ schedule: 'never' })).toEqual(['schedule']);
    expect(bad({ tz: 'Mars/Olympus' })).toEqual(['tz']);
    expect(bad({ items: 'a[' })).toEqual(['items']);
    expect(bad({ item_key: 'a[' })).toEqual(['item_key']);
    expect(bad({ event: 'Not Valid' })).toEqual(['event']);
    expect(bad({ first_run: 'later' })).toEqual(['first_run']);
    expect(bad({ keep: 0 })).toEqual(['keep']);
    expect(bad({ extra: 1 })).toEqual(['']); // unknown keys are reported at the parent
  });
});

describe('Poller', () => {
  it('emits one event per new item, keyed and deduplicated, and remembers what it saw', async () => {
    const p = poller(
      { args: { owner: 'acme', repo: '${env.REPO}', token: '${secrets.gh}' } },
      { gh: 'ghp-secret' },
    );

    clients.next = prs(1, 2);
    expect(await p.poll()).toEqual({
      status: 'polled',
      items: 2,
      new: 2,
      emitted: 2,
      duplicates: 0,
    });
    expect(clients.calls).toEqual([
      {
        connector: 'github',
        op: 'list_pull_requests',
        args: { owner: 'acme', repo: 'site', token: 'ghp-secret' },
      },
    ]);
    expect(events()).toEqual([
      {
        type: 'github.pr_opened',
        source: 'prs',
        dedup_key: 'prs:1',
        payload: { number: 1, title: 'PR 1' },
      },
      {
        type: 'github.pr_opened',
        source: 'prs',
        dedup_key: 'prs:2',
        payload: { number: 2, title: 'PR 2' },
      },
    ]);
    expect(seen()).toEqual(['1', '2']);
    // Each item starts its own causal chain.
    const [a, b] = env.store.events.listAfter(0, 10);
    expect(a?.correlation_id).not.toBe(b?.correlation_id);
    expect(a?.parent_id).toBeNull();

    // Nothing new: nothing emitted, nothing rewritten.
    const updatedAt = env.store.state.get('prs', SEEN_KEY)?.updated_at;
    env.clock.set('2026-09-19T11:00:00.000Z');
    expect(await p.poll()).toEqual({
      status: 'polled',
      items: 2,
      new: 0,
      emitted: 0,
      duplicates: 0,
    });
    expect(events()).toHaveLength(2);
    expect(env.store.state.get('prs', SEEN_KEY)?.updated_at).toBe(updatedAt);

    // One PR closed, one opened; the closed one stays seen.
    clients.next = prs(2, 3);
    expect(await p.poll()).toEqual({
      status: 'polled',
      items: 2,
      new: 1,
      emitted: 1,
      duplicates: 0,
    });
    expect(events().map((e) => e.dedup_key)).toEqual(['prs:1', 'prs:2', 'prs:3']);
    expect(seen()).toEqual(['1', '2', '3']);

    // PR 1 reopens: still seen, not emitted again.
    clients.next = prs(1, 2, 3);
    expect(await p.poll()).toMatchObject({ new: 0, emitted: 0 });
    expect(seen()).toEqual(['1', '2', '3']);

    expect(p.status()).toMatchObject({
      name: 'prs',
      connector: 'github',
      op: 'list_pull_requests',
      last_poll: '2026-09-19T11:00:00.000Z',
      last_error: null,
      polling: false,
      next_run: null,
    });
    const log = JSON.stringify(env.lines);
    expect(log).toContain('poller.polled');
    expect(log).not.toContain('ghp-secret');
  });

  it('first_run: skip seeds the seen list silently, then emits only what appears later', async () => {
    const p = poller({ first_run: 'skip' });
    clients.next = prs(10, 11);
    expect(await p.poll()).toEqual({
      status: 'polled',
      items: 2,
      new: 2,
      emitted: 0,
      duplicates: 0,
    });
    expect(events()).toEqual([]);
    expect(seen()).toEqual(['10', '11']);
    clients.next = prs(10, 11, 12);
    expect(await p.poll()).toMatchObject({ new: 1, emitted: 1 });
    expect(events().map((e) => e.dedup_key)).toEqual(['prs:12']);
  });

  it('forgets the oldest keys beyond keep and counts a repeated key once per batch', async () => {
    const p = poller({ keep: 3 });
    clients.next = prs(1, 2, 2, 3, 4);
    expect(await p.poll()).toMatchObject({ items: 5, new: 4, emitted: 4 });
    expect(seen()).toEqual(['2', '3', '4']);
    // Key 1 aged out; if it comes back it is new to the poller but the event dedup holds.
    clients.next = prs(1);
    expect(await p.poll()).toEqual({
      status: 'polled',
      items: 1,
      new: 1,
      emitted: 0,
      duplicates: 1,
    });
    expect(seen()).toEqual(['3', '4', '1']);
  });

  it('takes the result itself as the items when items is omitted, and string or number keys', async () => {
    const p = poller({ items: undefined, item_key: 'id' });
    clients.next = [{ id: 'a' }, { id: 7 }];
    expect(await p.poll()).toMatchObject({ items: 2, emitted: 2 });
    expect(seen()).toEqual(['a', '7']);
  });

  it('fails the poll, keeps state untouched and reports last_error on bad results', async () => {
    const p = poller();
    clients.next = { pull_requests: 'nope' };
    expect(await p.poll()).toEqual({
      status: 'failed',
      error: 'items "pull_requests" is not an array (got string)',
    });
    clients.next = { pull_requests: [{ number: 1 }, { title: 'no key' }] };
    expect(await p.poll()).toEqual({
      status: 'failed',
      error: 'item_key "number" of item 1 is not a string or a number (got null)',
    });
    clients.next = new Error('connector "github" is not running');
    expect(await p.poll()).toEqual({
      status: 'failed',
      error: 'connector "github" is not running',
    });
    expect(p.status().last_error).toBe('connector "github" is not running');
    expect(events()).toEqual([]);
    expect(seen()).toBeUndefined();
    expect(env.lines.filter((l) => l.msg === 'poller.failed')).toHaveLength(3);

    // A secret that cannot be resolved fails the poll too, without calling the op.
    const p2 = poller({ args: { token: '${secrets.missing}' } });
    clients.calls = [];
    expect(await p2.poll()).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('missing') as string,
    });
    expect(clients.calls).toEqual([]);

    // The next good poll clears the error.
    clients.next = prs(1);
    expect(await p.poll()).toMatchObject({ status: 'polled' });
    expect(p.status().last_error).toBeNull();
  });

  it('skips a tick while a poll is in flight and aborts it on stop', async () => {
    const p = poller();
    let release: (v: JsonValue) => void = () => undefined;
    clients.next = () =>
      new Promise<JsonValue>((r) => {
        release = r;
      });
    const first = p.poll();
    expect(p.status().polling).toBe(true);
    expect(await p.poll()).toEqual({ status: 'skipped', reason: 'in_flight' });
    release(prs(1));
    expect(await first).toMatchObject({ status: 'polled', emitted: 1 });
    expect(p.status().polling).toBe(false);

    // A call that only ends when its signal fires (as the MCP client's does).
    clients.next = (signal) =>
      new Promise<JsonValue>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    p.start();
    expect(p.status().next_run).not.toBeNull();
    const hung = p.poll();
    await p.stop();
    expect(p.status().next_run).toBeNull();
    expect(await hung).toEqual({ status: 'failed', error: 'aborted' });
    expect(p.status().polling).toBe(false);
  });

  it('rejects a manifest that is not a poller', () => {
    const r = parseManifest({ name: 'x', exec: ['true'] }, '/x.yaml');
    if (!r.ok) {
      throw new Error('unexpected');
    }
    const opts = {
      manifest: r.config,
      clients,
      store: env.store,
      bus,
      clock: env.clock,
      log: env.log,
      secrets: staticSecrets({}),
    };
    expect(() => new Poller(opts)).toThrow('not a poller');
  });
});

describe('Poller through the daemon', () => {
  let dir: string;
  let daemon: Daemon;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-poller-'));
  });
  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('polls a supervised connector on its cron and emits events tasks can react to', async () => {
    writeFileSync(
      join(dir, 'agent.yaml'),
      `
db: state.db
socket: core.sock
tasks: tasks.yaml
connectors:
  - name: fake
    exec: [node, ${FIXTURES}fake-mcp.ts]
    ops: [echo]
  - name: echo_poll
    builtin: poller
    config:
      schedule: "* * * * * *"
      connector: fake
      op: echo
      args: { value: [{ id: a, n: 1 }, { id: b, n: 2 }] }
      items: echoed
      item_key: id
      event: fake.item
`,
    );
    writeFileSync(
      join(dir, 'tasks.yaml'),
      `
tasks:
  - name: react
    trigger: { kind: event, type: fake.item }
    action: { kind: shell, cmd: [echo, "\${event.payload.id}"] }
`,
    );
    const lines: Record<string, unknown>[] = [];
    daemon = await startDaemon({
      configFile: join(dir, 'agent.yaml'),
      log: createLogger({
        level: 'debug',
        sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
      }),
    });
    expect(daemon.core.supervisor?.names()).toEqual(['fake']);
    expect(daemon.core.pollers.map((p) => p.status())).toMatchObject([
      { name: 'echo_poll', connector: 'fake', op: 'echo', schedule: '* * * * * *' },
    ]);
    const api = new ApiClient({ socketPath: daemon.config.socket });
    const until = async (pred: () => Promise<boolean>): Promise<void> => {
      const end = Date.now() + 10_000;
      while (!(await pred())) {
        if (Date.now() > end) {
          throw new Error('timed out waiting');
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(
      async () => (await api.listRuns({ task: 'react', status: 'succeeded' })).length === 2,
    );
    // A few more ticks pass; the same two items never fire again.
    await until(() => Promise.resolve(lines.filter((l) => l.msg === 'poller.polled').length >= 3));
    await daemon.core.executor.idle();
    const runs = await api.listRuns({ task: 'react' });
    expect(runs.map((r) => r.result).sort()).toEqual(['a', 'b']);
    expect((await api.getState('echo_poll', SEEN_KEY))?.value).toEqual(['a', 'b']);
    const items = daemon.core.store.events.listAfter(0, 1000).filter((e) => e.type === 'fake.item');
    expect(items.map((e) => e.source)).toEqual(['echo_poll', 'echo_poll']);
  }, 20_000);
});
