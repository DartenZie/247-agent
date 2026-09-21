import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAgentFile, parseAgent } from './agent.js';
import { checkConfigFile } from './check.js';

const EXAMPLES = new URL('../../../../docs/examples/', import.meta.url).pathname;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-agent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseAgent', () => {
  it('fills the documented defaults and resolves paths against the file', () => {
    const r = parseAgent('', '/etc/247-agent/agent.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config).toMatchObject({
      file: '/etc/247-agent/agent.yaml',
      db: '/var/lib/247-agent/state.db',
      socket: '/run/247-agent/core.sock',
      tasks: ['/etc/247-agent/tasks.yaml'],
      connectorPaths: [],
      connectors: [],
      workers: 4,
      log: { level: 'info' },
      limits: { max_event_depth: 32 },
      defaults: {
        timeout: '15m',
        retry: { attempts: 1, backoff: 'exponential', base: '30s', max: '1h' },
        sandbox: { backend: 'none', extra_args: [], ro_binds: [], rw_binds: [] },
      },
      secrets: { backend: 'env', prefix: 'OA_SECRET_' },
      providers: {},
      pricing: {},
      budgets: {},
    });
    expect(r.config.defaults.llm).toEqual({ max_tokens: 1024 });
    expect(r.config.defaults.decide).toEqual({ model: 'typesafe/jev-1.13' });
    const decide = parseAgent(
      'defaults: { decide: { provider: openrouter } }\n',
      '/srv/oa/agent.yaml',
    );
    expect(decide.ok && decide.config.defaults.decide).toEqual({
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
    });
  });

  it('parses providers, pricing, defaults.llm and budgets, and rejects literal API keys', () => {
    const r = parseAgent(
      [
        'providers:',
        '  anthropic: { type: anthropic, api_key: "${secrets.anthropic_api_key}" }',
        '  router: { type: openrouter, api_key: "${secrets.or_key}", base_url: "https://openrouter.ai/api/v1", headers: { X-Title: "${env.APP}" } }',
        'pricing: { claude-sonnet-5: { output: 12 }, gpt-5-mini: { input: 0.25, output: 2 } }',
        'defaults: { llm: { provider: anthropic, model: claude-haiku-4-5, effort: low } }',
        'budgets: { daily_usd: 10 }',
      ].join('\n'),
      '/srv/oa/agent.yaml',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config.providers.anthropic).toEqual({
      type: 'anthropic',
      api_key: '${secrets.anthropic_api_key}',
      headers: {},
    });
    expect(r.config.providers.router).toMatchObject({
      type: 'openrouter',
      headers: { 'X-Title': '${env.APP}' },
    });
    expect(r.config.pricing).toEqual({
      'claude-sonnet-5': { output: 12 },
      'gpt-5-mini': { input: 0.25, output: 2 },
    });
    expect(r.config.defaults.llm).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      effort: 'low',
    });
    expect(r.config.budgets).toEqual({ daily_usd: 10 });

    const bad = parseAgent(
      [
        'providers:',
        '  a: { type: anthropic, api_key: sk-ant-literal }',
        '  b: { type: openai, api_key: "${secrets.a}${secrets.b}" }',
        '  c: { type: openai, api_key: "${secrets.k}", headers: { X: "${event.x}" } }',
        '  Bad: { type: openai, api_key: "${secrets.k}" }',
        '  d: { type: gemini, api_key: "${secrets.k}" }',
        'budgets: { daily_usd: 0 }',
        'pricing: { m: { input: -1 } }',
      ].join('\n'),
      '/srv/oa/agent.yaml',
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      return;
    }
    expect(bad.issues.map((i) => i.path).sort()).toEqual([
      'budgets.daily_usd',
      'pricing.m.input',
      'providers.Bad',
      'providers.a.api_key',
      'providers.b.api_key',
      'providers.c.headers',
      'providers.d.type',
    ]);
    expect(bad.issues.find((i) => i.path === 'providers.a.api_key')?.message).toMatch(
      /single secret reference/,
    );
  });

  it('keeps relative paths relative to the agent file, not the cwd', () => {
    const r = parseAgent('db: ./data/state.db\ntasks: tasks/main.yaml\n', '/srv/oa/agent.yaml');
    expect(r.ok && r.config.db).toBe('/srv/oa/data/state.db');
    expect(r.ok && r.config.tasks).toEqual(['/srv/oa/tasks/main.yaml']);
  });

  it('accepts lists of tasks paths, connector paths and inline manifests', () => {
    const r = parseAgent(
      [
        'tasks: [tasks.yaml, tasks.d]',
        'connectors:',
        '  - connectors.d',
        '  - { name: chat, exec: [node, chat.js], config: { token: "${secrets.chat_token}" } }',
        'secrets: { backend: file, path: secrets.yaml }',
        'defaults: { retry: { attempts: 3 } }',
      ].join('\n'),
      '/srv/oa/agent.yaml',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config.tasks).toEqual(['/srv/oa/tasks.yaml', '/srv/oa/tasks.d']);
    expect(r.config.connectorPaths).toEqual(['/srv/oa/connectors.d']);
    expect(r.config.connectors).toMatchObject([{ name: 'chat', file: '/srv/oa/agent.yaml' }]);
    expect(r.config.secrets).toEqual({ backend: 'file', path: 'secrets.yaml' });
    expect(r.config.defaults.retry).toMatchObject({ attempts: 3, backoff: 'exponential' });

    const sandboxed = parseAgent('defaults: { sandbox: bwrap }\n', '/srv/oa/agent.yaml');
    expect(sandboxed.ok && sandboxed.config.defaults.sandbox).toMatchObject({ backend: 'bwrap' });

    const bad = parseAgent(
      'connectors:\n  - { name: Bad, exec: [], config: { t: "${event.x}" } }\n',
      '/srv/oa/agent.yaml',
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      return;
    }
    expect(bad.issues.map((i) => i.path).sort()).toEqual([
      'connectors[0].config',
      'connectors[0].exec',
      'connectors[0].name',
    ]);
  });

  it('reports unknown keys, bad values and YAML errors as issues', () => {
    const r = parseAgent('workers: 0\nlog: { level: loud }\nbogus: 1\n', 'a.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.issues.map((i) => i.path).sort()).toEqual(['', 'log.level', 'workers']);
    expect(r.issues.find((i) => i.path === '')?.message).toMatch(/bogus/);

    const yaml = parseAgent('db: [', 'a.yaml');
    expect(!yaml.ok && yaml.issues[0]?.message).toMatch(/YAML syntax error/);
  });

  it('accepts the documented example', () => {
    const r = loadAgentFile(join(EXAMPLES, 'agent.yaml'));
    expect(r.ok).toBe(true);
    expect(r.ok && r.config.tasks).toEqual([join(EXAMPLES, 'website-updates.yaml')]);
    expect(r.ok && r.config.connectorPaths).toEqual([join(EXAMPLES, 'connectors.d')]);
  });

  it('treats a missing file as an issue', () => {
    expect(loadAgentFile(join(dir, 'nope.yaml'))).toMatchObject({ ok: false });
  });
});

describe('checkConfigFile', () => {
  it('validates a tasks file by its top-level key', () => {
    expect(checkConfigFile(join(EXAMPLES, 'website-updates.yaml'))).toEqual([
      {
        ok: true,
        file: join(EXAMPLES, 'website-updates.yaml'),
        kind: 'tasks',
        summary: '7 tasks',
      },
    ]);
  });

  it('cross-checks llm tasks against providers, prices and prompt files', () => {
    const agent = join(dir, 'agent.yaml');
    writeFileSync(join(dir, 'prompt.md'), 'x');
    writeFileSync(
      join(dir, 't.yaml'),
      [
        'tasks:',
        '  - name: a',
        '    trigger: { kind: manual }',
        '    action: { kind: llm, model: claude-9, input: x, system_file: nope.md }',
      ].join('\n'),
    );
    writeFileSync(
      agent,
      'tasks: t.yaml\nproviders: { p: { type: anthropic, api_key: "${secrets.k}" } }\n',
    );
    expect(checkConfigFile(agent)[1]).toMatchObject({
      ok: false,
      kind: 'tasks',
      issues: [
        expect.objectContaining({ path: 'tasks[0].action.provider' }),
        expect.objectContaining({ path: 'tasks[0].action.system_file' }),
      ],
    });
    writeFileSync(
      agent,
      [
        'tasks: t.yaml',
        'providers: { p: { type: anthropic, api_key: "${secrets.k}" } }',
        'defaults: { llm: { provider: p } }',
        'pricing: { claude-9: { input: 1, output: 2 } }',
      ].join('\n'),
    );
    expect(checkConfigFile(agent)[1]).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: 'tasks[0].action.system_file' })],
    });
    writeFileSync(agent, 'tasks: t.yaml\npricing: { claude-9: { output: 2 } }\n');
    expect(checkConfigFile(agent)).toEqual([
      expect.objectContaining({
        ok: false,
        kind: 'agent',
        issues: [expect.objectContaining({ path: 'pricing.claude-9' })],
      }),
    ]);
    expect(checkConfigFile(join(EXAMPLES, 'agent.yaml')).every((c) => c.ok)).toBe(true);
  });

  it('cross-checks decide tasks: the provider must be an openrouter one', () => {
    expect(checkConfigFile(join(EXAMPLES, 'decide-triage.yaml'))).toEqual([
      expect.objectContaining({ ok: true, kind: 'tasks', summary: '2 tasks' }),
    ]);
    const agent = join(dir, 'agent.yaml');
    writeFileSync(
      join(dir, 't.yaml'),
      [
        'tasks:',
        '  - name: d',
        '    trigger: { kind: manual }',
        '    action:',
        '      kind: decide',
        '      state: ${event.payload}',
        '      questions: { urgent: { type: noul, instructions: Urgent? } }',
      ].join('\n'),
    );
    writeFileSync(
      agent,
      [
        'tasks: t.yaml',
        'providers: { p: { type: anthropic, api_key: "${secrets.k}" } }',
        'defaults: { decide: { provider: p } }',
      ].join('\n'),
    );
    expect(checkConfigFile(agent)[1]).toMatchObject({
      ok: false,
      kind: 'tasks',
      issues: [
        expect.objectContaining({
          path: 'tasks[0].action.provider',
          message: expect.stringMatching(/decide needs an openrouter provider/) as string,
        }),
      ],
    });
    writeFileSync(
      agent,
      [
        'tasks: t.yaml',
        'providers: { p: { type: openrouter, api_key: "${secrets.k}" } }',
        'defaults: { decide: { provider: p } }',
      ].join('\n'),
    );
    expect(checkConfigFile(agent).every((c) => c.ok)).toBe(true);
  });

  it('validates an agent file together with the tasks file it points at', () => {
    const agent = join(dir, 'agent.yaml');
    writeFileSync(agent, 'tasks: t.yaml\n');
    writeFileSync(join(dir, 't.yaml'), 'tasks:\n  - name: a\n    trigger: { kind: manual }\n');
    const checks = checkConfigFile(agent);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ ok: true, kind: 'agent' });
    expect(checks[1]).toMatchObject({
      ok: false,
      kind: 'tasks',
      file: join(dir, 't.yaml'),
      issues: [expect.objectContaining({ path: 'tasks[0].action' })],
    });
  });

  it('reports a missing tasks file from the agent file', () => {
    const agent = join(dir, 'agent.yaml');
    writeFileSync(agent, 'tasks: missing.yaml\n');
    expect(checkConfigFile(agent)[1]).toMatchObject({ ok: false, kind: 'tasks' });
  });
});
