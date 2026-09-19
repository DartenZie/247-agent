import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkConfigFile } from './check.js';
import { parseManifest, type ConnectorConfig } from './connector.js';
import { expandConfigPaths, loadConnectors, loadTasks } from './load.js';

const task = (name: string): string =>
  `  - name: ${name}\n    trigger: { kind: manual }\n    action: { kind: shell, cmd: ["true"] }\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-merge-'));
  mkdirSync(join(dir, 'tasks.d'));
  writeFileSync(join(dir, 'tasks.yaml'), `tasks:\n${task('a')}`);
  writeFileSync(join(dir, 'tasks.d', '20-b.yaml'), `tasks:\n${task('b')}${task('c')}`);
  writeFileSync(join(dir, 'tasks.d', '10-z.yml'), `tasks:\n${task('z')}`);
  writeFileSync(join(dir, 'tasks.d', 'README.md'), 'not yaml\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('expandConfigPaths', () => {
  it('keeps files, expands directories to their yaml files in name order, passes missing paths through', () => {
    expect(
      expandConfigPaths([join(dir, 'tasks.yaml'), join(dir, 'tasks.d'), join(dir, 'nope.yaml')]),
    ).toEqual([
      join(dir, 'tasks.yaml'),
      join(dir, 'tasks.d', '10-z.yml'),
      join(dir, 'tasks.d', '20-b.yaml'),
      join(dir, 'nope.yaml'),
    ]);
  });
});

describe('loadTasks', () => {
  it('merges files and directories in order', () => {
    const r = loadTasks([join(dir, 'tasks.yaml'), join(dir, 'tasks.d')]);
    expect(r.ok).toBe(true);
    expect(r.config?.tasks.map((t) => t.name)).toEqual(['a', 'z', 'b', 'c']);
    expect(r.files.map((f) => f.ok)).toEqual([true, true, true]);
  });

  it('reports a task name defined in two files on the second file', () => {
    writeFileSync(join(dir, 'tasks.d', '30-dup.yaml'), `tasks:\n${task('a')}${task('d')}`);
    const r = loadTasks([join(dir, 'tasks.yaml'), join(dir, 'tasks.d')]);
    expect(r.ok).toBe(false);
    expect(r.config).toBeUndefined();
    const bad = r.files.find((f) => !f.ok);
    expect(bad).toMatchObject({
      file: join(dir, 'tasks.d', '30-dup.yaml'),
      issues: [
        {
          path: 'tasks[0].name',
          message: expect.stringMatching(
            /duplicate task name "a" \(also defined in .*tasks\.yaml\)/,
          ) as string,
        },
      ],
    });
  });

  it('reports unreadable files and an empty directory', () => {
    const r = loadTasks([join(dir, 'missing.yaml')]);
    expect(r.ok).toBe(false);
    expect(r.files[0]).toMatchObject({
      ok: false,
      issues: [{ message: expect.stringMatching(/cannot read/) as string }],
    });
    mkdirSync(join(dir, 'empty.d'));
    expect(loadTasks([join(dir, 'empty.d')])).toMatchObject({
      ok: false,
      files: [{ ok: false, issues: [{ message: 'no tasks files found' }] }],
    });
  });
});

describe('loadConnectors', () => {
  const inline = (name: string): ConnectorConfig => {
    const r = parseManifest({ name, exec: ['x'] }, join(dir, 'agent.yaml'));
    if (!r.ok) {
      throw new Error('bad inline manifest');
    }
    return r.config;
  };

  it('merges inline manifests with connectors.d files and rejects duplicate names', () => {
    mkdirSync(join(dir, 'connectors.d'));
    writeFileSync(
      join(dir, 'connectors.d', 'email.yaml'),
      'name: email\nexec: [node, email.js]\ncwd: ../bin\n',
    );
    writeFileSync(join(dir, 'connectors.d', 'bad.yaml'), 'name: bad\n');
    const r = loadConnectors([join(dir, 'connectors.d')], [inline('chat')]);
    expect(r.ok).toBe(false);
    expect(r.files).toMatchObject([
      { ok: true, name: 'chat' },
      { ok: false, file: join(dir, 'connectors.d', 'bad.yaml') },
      { ok: true, name: 'email' },
    ]);

    rmSync(join(dir, 'connectors.d', 'bad.yaml'));
    const ok = loadConnectors([join(dir, 'connectors.d')], [inline('chat')]);
    expect(ok.ok).toBe(true);
    expect(ok.connectors?.map((c) => c.name)).toEqual(['chat', 'email']);
    expect(ok.connectors?.[1]?.cwd).toBe(join(dir, 'bin'));

    const dup = loadConnectors([join(dir, 'connectors.d')], [inline('email')]);
    expect(dup.ok).toBe(false);
    expect(dup.files[1]).toMatchObject({
      ok: false,
      issues: [
        {
          path: 'name',
          message: expect.stringMatching(/duplicate connector name "email"/) as string,
        },
      ],
    });
  });
});

describe('checkConfigFile with directories and manifests', () => {
  it('validates agent.yaml with tasks.d and connectors.d, and a manifest on its own', () => {
    mkdirSync(join(dir, 'connectors.d'));
    writeFileSync(
      join(dir, 'connectors.d', 'email.yaml'),
      'name: email\nexec: [node, email.js]\nemits: [email.received]\n',
    );
    writeFileSync(
      join(dir, 'agent.yaml'),
      'tasks: [tasks.yaml, tasks.d]\nconnectors: connectors.d\n',
    );
    const checks = checkConfigFile(join(dir, 'agent.yaml'));
    expect(checks.map((c) => [c.kind, c.ok])).toEqual([
      ['agent', true],
      ['tasks', true],
      ['tasks', true],
      ['tasks', true],
      ['connector', true],
    ]);
    expect(checkConfigFile(join(dir, 'connectors.d', 'email.yaml'))).toEqual([
      {
        ok: true,
        file: join(dir, 'connectors.d', 'email.yaml'),
        kind: 'connector',
        summary: 'connector email',
      },
    ]);
    writeFileSync(
      join(dir, 'connectors.d', 'bad.yaml'),
      'name: bad\nexec: [x]\nconfig: { t: "${event.x}" }\n',
    );
    expect(checkConfigFile(join(dir, 'connectors.d', 'bad.yaml'))[0]).toMatchObject({
      ok: false,
      kind: 'connector',
      issues: [{ path: 'config', message: expect.stringMatching(/only \$\{secrets/) as string }],
    });
  });
});
