import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkConfigFile } from './check.js';
import { looksLikeManifest, parseManifest } from './connector.js';
import { loadConnectors } from './load.js';

const POLLER = {
  name: 'prs',
  builtin: 'poller',
  config: {
    schedule: '*/5 * * * *',
    connector: 'github',
    op: 'list_pull_requests',
    args: { owner: 'acme', token: '${secrets.gh}' },
    items: 'pull_requests',
    item_key: 'number',
    event: 'github.pr_opened',
  },
};

function issues(doc: unknown): string[] {
  const r = parseManifest(doc, '/x/connectors.d/m.yaml');
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('ConnectorManifest with builtin', () => {
  it('accepts a poller, defaults transport to none and emits to the configured event', () => {
    const r = parseManifest(POLLER, '/x/connectors.d/prs.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config).toMatchObject({
      name: 'prs',
      builtin: 'poller',
      transport: 'none',
      emits: ['github.pr_opened'],
      ops: [],
      file: '/x/connectors.d/prs.yaml',
    });
    expect(r.config.exec).toBeUndefined();
    expect(issues({ ...POLLER, emits: ['github.pr_opened', 'other.type'] })).toEqual([]);
    expect(issues({ ...POLLER, transport: 'none' })).toEqual([]);
  });

  it('keeps process manifests as they were', () => {
    const r = parseManifest({ name: 'email', exec: ['node', 'main.js'] }, '/x/c.d/email.yaml');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config).toMatchObject({ transport: 'stdio', emits: [] });
    expect(r.config.builtin).toBeUndefined();
    expect(looksLikeManifest({ name: 'x', exec: [] })).toBe(true);
    expect(looksLikeManifest({ name: 'x', builtin: 'poller' })).toBe(true);
    expect(looksLikeManifest({ name: 'x' })).toBe(false);
  });

  it('requires exactly one of exec and builtin', () => {
    expect(issues({ name: 'x' })).toEqual(['exec: exactly one of "exec" or "builtin" is required']);
    expect(issues({ ...POLLER, exec: ['node'] })).toEqual([
      'builtin: exactly one of "exec" or "builtin" is required',
    ]);
    expect(issues({ name: 'x', builtin: 'mailer' })).toEqual([
      expect.stringMatching(/^builtin: /) as string,
    ]);
  });

  it('rejects process-only fields, stdio transport and ops on a built-in', () => {
    expect(issues({ ...POLLER, cwd: '.', env: { A: 'b' }, health: { interval: '1s' } })).toEqual([
      'cwd: a built-in connector has no process: "cwd" does not apply',
      'env: a built-in connector has no process: "env" does not apply',
      'health: a built-in connector has no process: "health" does not apply',
    ]);
    expect(issues({ ...POLLER, transport: 'stdio' })).toEqual([
      'transport: a built-in connector serves no ops: transport must be "none"',
    ]);
    expect(issues({ ...POLLER, ops: ['x'] })).toEqual([
      'ops: a connector with transport "none" cannot serve ops',
    ]);
  });

  it("validates the poller's config under config.<field>", () => {
    expect(issues({ ...POLLER, config: { ...POLLER.config, schedule: 'soon' } })).toEqual([
      expect.stringMatching(/^config\.schedule: /) as string,
    ]);
    expect(issues({ ...POLLER, config: { ...POLLER.config, event: 'Bad Type' } })).toEqual([
      expect.stringMatching(/^config\.event: /) as string,
    ]);
    expect(issues({ ...POLLER, config: {} }).map((i) => i.split(':')[0])).toEqual([
      'config.schedule',
      'config.connector',
      'config.op',
      'config.item_key',
      'config.event',
    ]);
    expect(issues({ ...POLLER, emits: ['other.type'] })).toEqual([
      'emits: a poller emits its config.event "github.pr_opened"; list it or leave emits out',
    ]);
    // Manifest template rules still apply to a poller's config.
    expect(
      issues({ ...POLLER, config: { ...POLLER.config, args: { x: '${event.payload}' } } }),
    ).toEqual([
      'config: only ${secrets.<name>} and ${env.<VAR>} can be used in a manifest (found "event")',
    ]);
  });
});

describe('loadConnectors with pollers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-poller-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, text: string): string => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  const github = (ops: string): string =>
    write('github.yaml', `name: github\nexec: [npx, server-github]\nops: ${ops}\n`);
  const poller = (over = ''): string =>
    write(
      'prs.yaml',
      `name: prs\nbuiltin: poller\nconfig:\n  schedule: "*/5 * * * *"\n  connector: github\n  op: list_pull_requests\n  item_key: number\n  event: github.pr_opened\n${over}`,
    );

  it('resolves the target connector and its op allowlist', () => {
    const r = loadConnectors([github('[list_pull_requests]'), poller()]);
    expect(r.ok).toBe(true);
    expect(r.connectors?.map((c) => c.name)).toEqual(['github', 'prs']);
    expect(r.files).toEqual([
      { ok: true, file: join(dir, 'github.yaml'), name: 'github' },
      { ok: true, file: join(dir, 'prs.yaml'), name: 'prs' },
    ]);
    expect(loadConnectors([github('[]'), poller()]).ok).toBe(true);
  });

  it('reports a missing target, a target without ops, and an op outside the allowlist', () => {
    const missing = loadConnectors([poller()]);
    expect(missing.ok).toBe(false);
    expect(missing.files).toEqual([
      {
        ok: false,
        file: join(dir, 'prs.yaml'),
        issues: [{ path: 'config.connector', message: 'unknown connector "github"' }],
      },
    ]);

    const noOps = loadConnectors([
      write('github.yaml', 'name: github\nexec: [node, bot.js]\ntransport: none\n'),
      poller(),
    ]);
    expect(noOps.files[1]).toMatchObject({
      ok: false,
      issues: [{ path: 'config.connector', message: 'connector "github" serves no ops' }],
    });

    const notAllowed = loadConnectors([github('[get_pull_request]'), poller()]);
    expect(notAllowed.ok).toBe(false);
    expect(notAllowed.files).toEqual([
      { ok: true, file: join(dir, 'github.yaml'), name: 'github' },
      {
        ok: false,
        file: join(dir, 'prs.yaml'),
        issues: [
          {
            path: 'config.op',
            message: 'op "list_pull_requests" is not in the ops of connector "github"',
          },
        ],
      },
    ]);

    // Polling another poller is refused too (it serves no ops).
    const chained = loadConnectors([
      github('[]'),
      poller(),
      write(
        'two.yaml',
        'name: two\nbuiltin: poller\nconfig: { schedule: "* * * * *", connector: prs, op: x, item_key: id, event: a.b }\n',
      ),
    ]);
    expect(chained.files[2]).toMatchObject({
      ok: false,
      issues: [{ path: 'config.connector', message: 'connector "prs" serves no ops' }],
    });
  });

  it('is checked by oa validate through agent.yaml', () => {
    github('[list_pull_requests]');
    poller();
    write(
      'tasks.yaml',
      'tasks:\n  - { name: t, trigger: { kind: manual }, action: { kind: shell, cmd: ["true"] } }\n',
    );
    const agent = write('agent.yaml', 'tasks: tasks.yaml\nconnectors: [github.yaml, prs.yaml]\n');
    expect(checkConfigFile(agent).map((c) => (c.ok ? c.summary : c.issues))).toEqual([
      expect.stringContaining('connectors') as string,
      '1 tasks',
      'connector github',
      'connector prs',
    ]);
    expect(checkConfigFile(join(dir, 'prs.yaml'))).toEqual([
      { ok: true, file: join(dir, 'prs.yaml'), kind: 'connector', summary: 'connector prs' },
    ]);
  });
});
