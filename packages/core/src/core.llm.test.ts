import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoadError, createCore, type Core, type CoreLlmOptions } from './core.js';
import { resolvePricing } from './llm/pricing.js';
import { fakeProviderFactory } from './llm/testing.js';
import type { BatchStatus } from './llm/types.js';
import { createLogger } from './log.js';
import { staticSecrets } from './secrets/secrets.js';

const EXAMPLE = new URL('../../../docs/examples/website-updates.yaml', import.meta.url).pathname;
describe('createCore with providers', () => {
  const EXAMPLES = new URL('../../../docs/examples/', import.meta.url).pathname;
  let dir2: string;
  let core2: Core | undefined;
  let lines2: Record<string, unknown>[];

  const make = (over: Partial<CoreLlmOptions> = {}): Core => {
    lines2 = [];
    return createCore({
      tasksFiles: [join(dir2, 'tasks.yaml')],
      dbPath: join(dir2, 'state.db'),
      log: createLogger({
        level: 'debug',
        sink: (l) => lines2.push(JSON.parse(l) as Record<string, unknown>),
      }),
      secrets: staticSecrets({ anthropic_api_key: 'sk' }),
      llm: {
        providers: {
          anthropic: { type: 'anthropic', api_key: '${secrets.anthropic_api_key}', headers: {} },
        },
        pricing: resolvePricing({}),
        defaults: { provider: 'anthropic', model: 'claude-haiku-4-5', max_tokens: 1024 },
        budgets: {},
        configDir: EXAMPLES,
        factories: {},
        ...over,
      },
    });
  };

  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'oa-core-llm-'));
    writeFileSync(join(dir2, 'tasks.yaml'), readFileSync(EXAMPLE));
  });

  afterEach(async () => {
    await core2?.stop();
    core2 = undefined;
    rmSync(dir2, { recursive: true, force: true });
  });

  it('cross-checks llm tasks against the providers at start and on reload', async () => {
    core2 = make({ providers: {} });
    await expect(core2.start()).rejects.toThrow(ConfigLoadError);
    await expect(core2.start()).rejects.toThrow(
      /tasks\[1\]\.action\.provider: unknown provider "anthropic"/,
    );
    await core2.stop();
    core2 = make();
    await core2.start();
    writeFileSync(
      join(dir2, 'tasks.yaml'),
      readFileSync(EXAMPLE, 'utf8').replace('provider: anthropic', 'provider: missing'),
    );
    const reload = await core2.reload();
    expect(reload.ok).toBe(false);
    expect(reload.files[0]).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: 'tasks[1].action.provider' })],
    });
    expect(core2.config().tasks).toHaveLength(8); // the previous config stays active
  });

  it('runs an llm task through the service and fails it when no adapter is built in', async () => {
    core2 = make();
    await core2.start();
    core2.bus.publish({
      type: 'email.received',
      source: 'email',
      payload: { from: 'editor@example.com', subject: 'Event', body: '…' },
    });
    core2.bus.dispatcher.drain();
    await core2.executor.idle();
    const run = core2.store.runs.listByStatus('failed')[0];
    expect(run).toMatchObject({
      task: 'classify_email',
      error: 'provider type "anthropic" has no adapter in this build',
    });
    expect(core2.store.events.listAfter(0, 100).map((e) => e.type)).toContain(
      'task.classify_email.failed',
    );
  });
});

describe('createCore with batch: true', () => {
  let dir: string;
  let core: Core | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-core-batch-'));
    writeFileSync(
      join(dir, 'tasks.yaml'),
      `tasks:
  - name: summarise
    trigger: { kind: event, type: doc.added }
    action:
      kind: llm
      batch: true
      input: \${event.payload.text}
      output_schema: { type: object }
    emit:
      - type: doc.summarised
        payload: { summary: "\${result.summary}" }
`,
    );
  });

  afterEach(async () => {
    await core?.stop();
    core = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('parks the run on its batch and finishes it when the poller publishes the result', async () => {
    let status: BatchStatus = { status: 'in_progress' };
    const fake = fakeProviderFactory(undefined, undefined, () => status);
    core = createCore({
      tasksFiles: [join(dir, 'tasks.yaml')],
      dbPath: join(dir, 'state.db'),
      log: createLogger({ level: 'error', sink: () => undefined }),
      secrets: staticSecrets({ anthropic_api_key: 'sk' }),
      llm: {
        providers: {
          anthropic: { type: 'anthropic', api_key: '${secrets.anthropic_api_key}', headers: {} },
        },
        pricing: resolvePricing({}),
        defaults: { provider: 'anthropic', model: 'claude-haiku-4-5', max_tokens: 1024 },
        budgets: {},
        configDir: dir,
        batches: { poll: '1h' },
        factories: { anthropic: fake.factory },
      },
    });
    await core.start();
    const poller = core.batchPoller;
    if (poller === undefined) {
      throw new Error('no batch poller');
    }
    core.bus.publish({ type: 'doc.added', source: 'test', payload: { text: 'long text' } });
    core.bus.dispatcher.drain();
    await core.executor.idle();
    const [waiting] = core.store.runs.listByStatus('waiting');
    expect(waiting?.task).toBe('summarise');
    expect(fake.batches[0]?.req).toMatchObject({ input: 'long text', customId: waiting?.id });
    expect(fake.requests).toEqual([]); // nothing went through the synchronous path

    await poller.run();
    core.bus.dispatcher.drain();
    await core.executor.idle();
    expect(core.store.runs.getById(waiting?.id ?? '')?.status).toBe('waiting');

    status = {
      status: 'succeeded',
      response: {
        output: { summary: 'short' },
        usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'end',
      },
    };
    await poller.run();
    core.bus.dispatcher.drain();
    await core.executor.idle();
    const done = core.store.runs.getById(waiting?.id ?? '');
    expect(done).toMatchObject({ status: 'succeeded', result: { summary: 'short' } });
    const types = core.store.events.listAfter(0, 100).map((e) => e.type);
    expect(types).toEqual([
      'doc.added',
      'llm.batch.ended',
      'task.summarise.succeeded',
      'doc.summarised',
    ]);
    const summarised = core.store.events.listAfter(0, 100).find((e) => e.type === 'doc.summarised');
    expect(summarised?.payload).toEqual({ summary: 'short' });
    const rows = core.store.ledger.listByRun(waiting?.id ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usd).toBeCloseTo(0.00075);
    expect(core.store.batches.count()).toBe(0);
  });
});
