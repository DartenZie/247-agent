import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoadError, createCore, type Core, type CoreLlmOptions } from './core.js';
import { resolvePricing } from './llm/pricing.js';
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
    const reload = core2.reload();
    expect(reload.ok).toBe(false);
    expect(reload.files[0]).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: 'tasks[1].action.provider' })],
    });
    expect(core2.config().tasks).toHaveLength(7); // the previous config stays active
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
