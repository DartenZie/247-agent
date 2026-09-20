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
    });
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
    expect(r.ok && r.config.tasks).toEqual([join(EXAMPLES, 'orchestra-website.yaml')]);
    expect(r.ok && r.config.connectorPaths).toEqual([join(EXAMPLES, 'connectors.d')]);
  });

  it('treats a missing file as an issue', () => {
    expect(loadAgentFile(join(dir, 'nope.yaml'))).toMatchObject({ ok: false });
  });
});

describe('checkConfigFile', () => {
  it('validates a tasks file by its top-level key', () => {
    expect(checkConfigFile(join(EXAMPLES, 'orchestra-website.yaml'))).toEqual([
      {
        ok: true,
        file: join(EXAMPLES, 'orchestra-website.yaml'),
        kind: 'tasks',
        summary: '7 tasks',
      },
    ]);
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
