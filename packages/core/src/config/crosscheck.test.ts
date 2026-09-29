import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePricing } from '../llm/pricing.js';
import { parseManifest } from './connector.js';
import {
  checkLlmTasks,
  checkSandboxes,
  isInside,
  type LlmCheckContext,
  type SandboxCheckContext,
} from './crosscheck.js';
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

describe('checkLlmTasks: decide', () => {
  const decide = (action: Record<string, unknown>) =>
    Task.parse({
      name: 'd',
      trigger: { kind: 'manual' },
      action: {
        kind: 'decide',
        state: '${event.payload}',
        questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
        ...action,
      },
    });

  it('passes an openrouter provider, from the action or defaults.decide, with any model', () => {
    expect(
      checkLlmTasks(
        [
          decide({ provider: 'router' }),
          decide({ provider: 'router', model: '~typesafe/jev-latest' }),
        ],
        ctx(),
      ),
    ).toEqual([]);
    expect(
      checkLlmTasks(
        [decide({})],
        ctx({ decideDefaults: { provider: 'router', model: 'typesafe/jev-1.13' } }),
      ),
    ).toEqual([]);
  });

  it('reports a missing or unknown provider and a provider of the wrong type', () => {
    expect(checkLlmTasks([decide({})], ctx())).toEqual([
      {
        path: 'tasks[0].action.provider',
        message: 'no provider: set action.provider or defaults.decide.provider in agent.yaml',
      },
    ]);
    expect(checkLlmTasks([decide({ provider: 'nope' })], ctx())[0]?.message).toMatch(
      /unknown provider "nope"/,
    );
    const wrong = checkLlmTasks([decide({ provider: 'anthropic' })], ctx());
    expect(wrong.map((i) => i.path)).toEqual(['tasks[0].action.provider']);
    expect(wrong[0]?.message).toMatch(
      /decide needs an openrouter provider.*"anthropic" is type anthropic/,
    );
  });
});

describe('checkSandboxes', () => {
  const manifest = (doc: Record<string, unknown>) => {
    const r = parseManifest(
      { name: 'claude', exec: ['claude-agent-acp'], transport: 'acp', ...doc },
      '/etc/247-agent/connectors.d/claude.yaml',
    );
    if (!r.ok) {
      throw new Error(JSON.stringify(r.issues));
    }
    return r.config;
  };
  const agentTask = (over: Record<string, unknown> = {}) =>
    Task.parse({
      name: 'edit',
      trigger: { kind: 'manual' },
      action: {
        kind: 'agent',
        workspace: { kind: 'git-worktree', repo: '/var/lib/247-agent/repos/site' },
        tools: ['read', 'edit'],
        prompt: 'x',
        ...over,
      },
    });
  const sctx = (over: Partial<SandboxCheckContext> = {}): SandboxCheckContext => ({
    manifests: [
      manifest({ sandbox: { backend: 'bwrap', ro_binds: ['/var/lib/247-agent/repos'] } }),
    ],
    defaultConnector: 'claude',
    workDir: '/var/lib/247-agent/work',
    protected: [
      { path: '/var/lib/247-agent/state.db', what: 'database' },
      { path: '/run/247-agent/core.sock', what: 'socket' },
      { path: '/etc/247-agent/agent.yaml', what: 'config file' },
    ],
    ...over,
  });

  it('passes a repo under a bind, a temp workspace, an unsandboxed connector and no sandbox at all', () => {
    const empty = { tasks: [], manifests: [], agent: [] };
    expect(checkSandboxes([agentTask(), shell], sctx())).toEqual(empty);
    expect(
      checkSandboxes([agentTask({ workspace: { kind: 'temp' } })], sctx({ manifests: [] })),
    ).toEqual(empty);
    expect(
      checkSandboxes([agentTask({ connector: 'codex' })], sctx({ manifests: [manifest({})] })),
    ).toEqual(empty);
    expect(checkSandboxes([agentTask()], sctx({ manifests: [manifest({})] }))).toEqual(empty);
  });

  it('reports a repo outside every bind, on the action or the default connector', () => {
    const ctx = sctx({ manifests: [manifest({ sandbox: 'bwrap' })] });
    const r = checkSandboxes([agentTask(), agentTask({ connector: 'claude' })], ctx);
    expect(r.tasks.map((i) => i.path)).toEqual([
      'tasks[0].action.workspace.repo',
      'tasks[1].action.workspace.repo',
    ]);
    expect(r.tasks[0]?.message).toMatch(
      /not visible to the sandboxed agent program "claude": add it to sandbox.ro_binds in \/etc\/247-agent\/connectors.d\/claude.yaml/,
    );
    // A repo under work_dir is visible without a bind.
    expect(
      checkSandboxes(
        [agentTask({ workspace: { kind: 'git-worktree', repo: '/var/lib/247-agent/work/base' } })],
        ctx,
      ).tasks,
    ).toEqual([]);
  });

  it('refuses a sandboxed shell action whose cwd or binds hold a protected file', () => {
    const shellTask = (action: Record<string, unknown>) =>
      Task.parse({ name: 'sh', trigger: { kind: 'manual' }, action: { kind: 'shell', ...action } });
    const ctx = sctx({ manifests: [] });
    // Its own sandbox: cwd is bound read-write, the binds as listed; a templated cwd is left alone.
    const r = checkSandboxes(
      [
        shellTask({
          cmd: ['true'],
          cwd: '/var/lib/247-agent',
          sandbox: { backend: 'bwrap', ro_binds: ['/etc/247-agent'] },
        }),
        shellTask({ cmd: ['true'], cwd: '${event.payload.dir}', sandbox: 'bwrap' }),
        shellTask({ cmd: ['true'], cwd: '/var/lib/247-agent' }),
        Task.parse({
          name: 'seq',
          trigger: { kind: 'manual' },
          action: {
            kind: 'sequence',
            steps: [{ kind: 'shell', cmd: ['true'], cwd: '/run/247-agent', sandbox: 'bwrap' }],
          },
        }),
      ],
      ctx,
    );
    expect(r.tasks).toEqual([
      {
        path: 'tasks[0].action.cwd',
        message:
          '/var/lib/247-agent would expose the database /var/lib/247-agent/state.db to the sandboxed command',
      },
      {
        path: 'tasks[0].action.sandbox.ro_binds[0]',
        message:
          '/etc/247-agent would expose the config file /etc/247-agent/agent.yaml to the sandboxed command',
      },
      {
        path: 'tasks[3].action.steps[0].cwd',
        message:
          '/run/247-agent would expose the socket /run/247-agent/core.sock to the sandboxed command',
      },
    ]);
    // `defaults.sandbox` applies to the unsandboxed action (tasks[2]) and its binds to all of them.
    const withDefault = checkSandboxes(
      [shellTask({ cmd: ['true'], cwd: '/var/lib/247-agent' })],
      sctx({
        manifests: [],
        defaultSandbox: { backend: 'bwrap', extra_args: [], ro_binds: ['/etc'], rw_binds: [] },
      }),
    );
    expect(withDefault.tasks.map((i) => i.path)).toEqual(['tasks[0].action.cwd']);
    expect(withDefault.agent).toEqual([
      {
        path: 'defaults.sandbox.ro_binds[0]',
        message:
          '/etc would expose the config file /etc/247-agent/agent.yaml to every sandboxed shell action',
      },
    ]);
  });

  it('refuses binds and a work_dir that would show the daemon its own files, and an invisible cwd', () => {
    const r = checkSandboxes(
      [],
      sctx({
        manifests: [
          manifest({
            cwd: '/srv/agents',
            sandbox: { backend: 'bwrap', ro_binds: ['/etc'], rw_binds: ['/var/lib/247-agent'] },
          }),
        ],
        workDir: '/run/247-agent',
      }),
    );
    expect(r.agent).toEqual([
      {
        path: 'defaults.agent.work_dir',
        message: expect.stringMatching(
          /\/run\/247-agent contains the socket \/run\/247-agent\/core.sock, which a sandboxed agent program \(connector "claude"\) could then read/,
        ) as string,
      },
    ]);
    expect(r.manifests).toEqual([
      {
        file: '/etc/247-agent/connectors.d/claude.yaml',
        issues: [
          {
            path: 'sandbox.ro_binds[0]',
            message:
              '/etc would expose the config file /etc/247-agent/agent.yaml to the sandboxed agent program',
          },
          {
            path: 'sandbox.rw_binds[0]',
            message:
              '/var/lib/247-agent would expose the database /var/lib/247-agent/state.db to the sandboxed agent program',
          },
          {
            path: 'cwd',
            message: expect.stringMatching(
              /^\/srv\/agents is not visible inside the sandbox/,
            ) as string,
          },
        ],
      },
    ]);
  });
});
