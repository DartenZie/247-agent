import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePricing } from '../llm/pricing.js';
import { checkLlmTasks, isInside, type LlmCheckContext } from './crosscheck.js';
import { Task } from './schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-xcheck-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'p.md'), 'x');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<LlmCheckContext> = {}): LlmCheckContext => ({
  providers: {
    anthropic: { type: 'anthropic', api_key: '${secrets.k}', headers: {} },
    router: { type: 'openrouter', api_key: '${secrets.k}', headers: {} },
  },
  pricing: resolvePricing({}),
  defaults: { provider: 'anthropic', model: 'claude-haiku-4-5', max_tokens: 1024 },
  configDir: dir,
  ...over,
});

const task = (action: Record<string, unknown>) =>
  Task.parse({
    name: 'a',
    trigger: { kind: 'manual' },
    action: { kind: 'llm', input: 'x', ...action },
  });

const shell = Task.parse({
  name: 's',
  trigger: { kind: 'manual' },
  action: { kind: 'shell', cmd: ['x'] },
});

describe('checkLlmTasks', () => {
  it('passes a fully resolved task, an OpenRouter model without a price, and non-llm tasks', () => {
    expect(
      checkLlmTasks(
        [
          shell,
          task({ system_file: 'prompts/p.md' }),
          task({ provider: 'router', model: 'vendor/x' }),
        ],
        ctx(),
      ),
    ).toEqual([]);
  });

  it('reports missing defaults, unknown providers, unpriced models and bad system files with task paths', () => {
    const issues = checkLlmTasks(
      [
        shell,
        task({}),
        task({ provider: 'nope' }),
        task({ model: 'claude-9' }),
        task({ system_file: 'prompts/missing.md' }),
        task({ system_file: '../outside.md' }),
      ],
      ctx({ defaults: { max_tokens: 1024 } }),
    );
    expect(issues.map((i) => i.path)).toEqual([
      'tasks[1].action.provider',
      'tasks[1].action.model',
      'tasks[2].action.model',
      'tasks[2].action.provider',
      'tasks[3].action.provider',
      'tasks[4].action.provider',
      'tasks[4].action.model',
      'tasks[4].action.system_file',
      'tasks[5].action.provider',
      'tasks[5].action.model',
      'tasks[5].action.system_file',
    ]);
    expect(issues[3]?.message).toMatch(/unknown provider "nope"/);
    const priced = checkLlmTasks([task({ model: 'claude-9' })], ctx());
    expect(priced).toEqual([
      {
        path: 'tasks[0].action.model',
        message: expect.stringMatching(/no price for model "claude-9"/) as string,
      },
    ]);
    expect(checkLlmTasks([task({ system_file: '../outside.md' })], ctx())[0]?.message).toMatch(
      /stay under the config directory/,
    );
    expect(checkLlmTasks([task({ system_file: 'prompts/missing.md' })], ctx())[0]?.message).toMatch(
      /not found/,
    );
  });

  it('isInside handles the directory itself and prefix look-alikes', () => {
    expect(isInside('/srv/oa', '/srv/oa')).toBe(true);
    expect(isInside('/srv/oa', '/srv/oa/prompts/p.md')).toBe(true);
    expect(isInside('/srv/oa', '/srv/oa2/p.md')).toBe(false);
    expect(isInside('/srv/oa', '/srv/oa/../etc')).toBe(false);
  });
});
