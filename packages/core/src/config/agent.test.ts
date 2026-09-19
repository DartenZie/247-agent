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
    const r = parseAgent('', '/etc/online-agent/agent.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config).toMatchObject({
      file: '/etc/online-agent/agent.yaml',
      db: '/var/lib/online-agent/state.db',
      socket: '/run/online-agent/core.sock',
      tasks: '/etc/online-agent/tasks.yaml',
      workers: 4,
      log: { level: 'info' },
      limits: { max_event_depth: 32 },
      defaults: { timeout: '15m' },
    });
  });

  it('keeps relative paths relative to the agent file, not the cwd', () => {
    const r = parseAgent('db: ./data/state.db\ntasks: tasks/main.yaml\n', '/srv/oa/agent.yaml');
    expect(r.ok && r.config.db).toBe('/srv/oa/data/state.db');
    expect(r.ok && r.config.tasks).toBe('/srv/oa/tasks/main.yaml');
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
    expect(r.ok && r.config.tasks).toBe(join(EXAMPLES, 'orchestra-website.yaml'));
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
