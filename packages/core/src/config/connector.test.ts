import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkConfigFile } from './check.js';
import { looksLikeManifest, parseManifest, unitSocket } from './connector.js';
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

describe('ConnectorManifest with transport acp', () => {
  const ACP = { name: 'claude', exec: ['claude-agent-acp'], transport: 'acp' };

  it('accepts an agent program with env only', () => {
    const r = parseManifest({ ...ACP, env: { ANTHROPIC_API_KEY: '${secrets.k}' } }, '/x/c.yaml');
    expect(r.ok).toBe(true);
    expect(r.ok && r.config).toMatchObject({ transport: 'acp', ops: [], emits: [] });
  });

  it('rejects ops, emits and a built-in on an acp connector', () => {
    expect(issues({ ...ACP, ops: ['x'] })).toEqual([
      expect.stringMatching(/^ops: an acp connector runs agent sessions/),
    ]);
    expect(issues({ ...ACP, emits: ['a.b'] })).toEqual([
      expect.stringMatching(/^emits: an acp connector runs agent sessions/),
    ]);
    expect(
      issues({ name: 'p', builtin: 'poller', transport: 'acp', config: POLLER.config }),
    ).toEqual([expect.stringMatching(/^transport: a built-in connector cannot be an acp agent/)]);
  });
});

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

describe('health checks in a manifest', () => {
  const parse = (doc: Record<string, unknown>) =>
    parseManifest({ name: 'c', exec: ['x'], ...doc }, '/x/c.yaml');

  it('fills the defaults, requires an interval and rejects health on non-stdio connectors', () => {
    const ok = parse({ health: { interval: '30s' } });
    expect(ok.ok && ok.config.health).toEqual({ interval: '30s', timeout: '10s', failures: 3 });
    const noInterval = parse({ health: {} });
    expect(!noInterval.ok && noInterval.issues.map((i) => i.path)).toEqual(['health.interval']);
    for (const transport of ['none', 'acp']) {
      const r = parse({ transport, health: { interval: '30s' } });
      expect(!r.ok && r.issues).toEqual([
        expect.objectContaining({
          path: 'health',
          message: expect.stringMatching(/MCP server/) as unknown,
        }),
      ]);
    }
    const bad = parse({ health: { interval: 'soon', failures: 0 } });
    expect(!bad.ok && bad.issues.map((i) => i.path).sort()).toEqual([
      'health.failures',
      'health.interval',
    ]);
  });
});

describe('sandbox in a manifest', () => {
  const ACP = { name: 'claude', exec: ['claude-agent-acp'], transport: 'acp' };

  it('is accepted on an acp connector in both forms', () => {
    const short = parseManifest({ ...ACP, sandbox: 'bwrap' }, '/x/c.yaml');
    expect(short.ok && short.config.sandbox).toEqual({
      backend: 'bwrap',
      extra_args: [],
      ro_binds: [],
      rw_binds: [],
    });
    const long = parseManifest(
      { ...ACP, sandbox: { backend: 'bwrap', ro_binds: ['/srv/site'] } },
      '/x/c.yaml',
    );
    expect(long.ok && long.config.sandbox?.ro_binds).toEqual(['/srv/site']);
    expect(issues({ ...ACP, sandbox: 'firejail' })).toEqual([
      expect.stringMatching(/^sandbox/) as string,
    ]);
  });

  it('takes a network allowlist with bwrap and names a bad entry', () => {
    const ok = parseManifest(
      {
        ...ACP,
        sandbox: { backend: 'bwrap', network: { allow: ['api.anthropic.com', '*.npmjs.org'] } },
      },
      '/x/c.yaml',
    );
    expect(ok.ok && ok.config.sandbox).toMatchObject({
      network: { allow: ['api.anthropic.com', '*.npmjs.org'] },
    });
    expect(
      issues({ ...ACP, sandbox: { backend: 'bwrap', network: { allow: ['ok.test', 'a/b'] } } }),
    ).toEqual([
      expect.stringMatching(/^sandbox\.network\.allow\[1\]: "a\/b": the host must be a hostname/),
    ]);
    expect(issues({ ...ACP, sandbox: { backend: 'none', network: { allow: [] } } })).toEqual([
      expect.stringMatching(/^sandbox\.network: a network allowlist needs backend: bwrap/),
    ]);
  });

  it('is refused on connectors that need the core socket, unless it is none', () => {
    for (const transport of ['stdio', 'none']) {
      expect(issues({ name: 'c', exec: ['x'], transport, sandbox: 'bwrap' })).toEqual([
        expect.stringMatching(/^sandbox: only an acp connector/) as string,
      ]);
      expect(issues({ name: 'c', exec: ['x'], transport, sandbox: 'none' })).toEqual([]);
    }
  });

  it('refuses config on an acp connector, which gets no OA_CONFIG_JSON', () => {
    expect(issues({ ...ACP, config: { model: 'x' } })).toEqual([
      expect.stringMatching(/^config: an acp connector gets no OA_CONFIG_JSON/) as string,
    ]);
  });
});

describe('oa validate with a sandboxed agent program', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oa-sbx-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, text: string): string => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  const tasks = (repo: string): void => {
    write(
      'tasks.yaml',
      `tasks:
  - name: edit
    trigger: { kind: manual }
    action:
      kind: agent
      workspace: { kind: git-worktree, repo: ${repo} }
      tools: [read, edit]
      prompt: do it
`,
    );
  };

  it('passes when the repo is bound and nothing of the daemon is', () => {
    tasks('/srv/repos/site');
    write(
      'claude.yaml',
      'name: claude\nexec: [claude-agent-acp]\ntransport: acp\nsandbox: { backend: bwrap, ro_binds: [/srv/repos/site] }\n',
    );
    const agent = write(
      'agent.yaml',
      'db: state.db\ntasks: tasks.yaml\nconnectors: [claude.yaml]\ndefaults: { agent: { connector: claude } }\n',
    );
    expect(checkConfigFile(agent).map((c) => (c.ok ? c.summary : c.issues))).toEqual([
      expect.stringContaining('connectors') as string,
      '1 tasks',
      'connector claude',
    ]);
  });

  it('reports an unbound repo, a bind over the daemon files and a work_dir holding them', () => {
    tasks('/srv/repos/site');
    write(
      'claude.yaml',
      `name: claude\nexec: [claude-agent-acp]\ntransport: acp\ncwd: /elsewhere\nsandbox: { backend: bwrap, ro_binds: [${dir}] }\n`,
    );
    const agent = write(
      'agent.yaml',
      'db: state.db\ntasks: tasks.yaml\nconnectors: [claude.yaml]\nsecrets: { backend: file, path: secrets.yaml }\ndefaults: { agent: { connector: claude, work_dir: . } }\n',
    );
    const checks = checkConfigFile(agent);
    const byFile = Object.fromEntries(
      checks.map((c) => [c.file.slice(dir.length + 1), c.ok ? 'ok' : c.issues]),
    );
    // The socket keeps its default path under /run, so it is neither in work_dir nor in the bind.
    expect(byFile['agent.yaml']).toEqual(
      ['database', 'config file', 'secrets file'].map((what) => ({
        path: 'defaults.agent.work_dir',
        message: expect.stringMatching(`contains the ${what}`) as string,
      })),
    );
    expect(byFile['tasks.yaml']).toEqual([
      {
        path: 'tasks[0].action.workspace.repo',
        message: expect.stringMatching(
          /\/srv\/repos\/site is not visible to the sandboxed agent program "claude": add it to sandbox.ro_binds/,
        ) as string,
      },
    ]);
    expect(byFile['claude.yaml']).toEqual([
      ...['database', 'config file', 'secrets file'].map((what) => ({
        path: 'sandbox.ro_binds[0]',
        message: expect.stringMatching(`expose the ${what}`) as string,
      })),
      { path: 'cwd', message: expect.stringMatching(/not visible inside the sandbox/) as string },
    ]);
  });

  it('reports a bind over the directory of the network allowlist proxies, beside the socket', () => {
    tasks('/srv/repos/site');
    write(
      'claude.yaml',
      `name: claude\nexec: [claude-agent-acp]\ntransport: acp\nsandbox: { backend: bwrap, ro_binds: [/srv/repos/site, ${dir}/run/core.sock.net] }\n`,
    );
    const agent = write(
      'agent.yaml',
      'db: state.db\nsocket: run/core.sock\ntasks: tasks.yaml\nconnectors: [claude.yaml]\ndefaults: { agent: { connector: claude } }\n',
    );
    const byFile = Object.fromEntries(
      checkConfigFile(agent).map((c) => [c.file.slice(dir.length + 1), c.ok ? 'ok' : c.issues]),
    );
    expect(byFile['claude.yaml']).toEqual([
      {
        path: 'sandbox.ro_binds[1]',
        message: expect.stringMatching(
          /would expose the proxy socket directory .*run\/core\.sock\.net /,
        ) as string,
      },
    ]);
  });

  it('checks an inline manifest and does not care about unsandboxed agents', () => {
    tasks('/srv/repos/site');
    const agent = write(
      'agent.yaml',
      `db: state.db
tasks: tasks.yaml
defaults: { agent: { connector: claude } }
connectors:
  - { name: claude, exec: [claude-agent-acp], transport: acp, sandbox: { backend: bwrap, ro_binds: [${dir}] } }
  - { name: codex, exec: [codex-acp], transport: acp }
`,
    );
    const [first] = checkConfigFile(agent);
    // The bind covers the database and agent.yaml in `dir`; the socket has its default path elsewhere.
    expect(first?.ok === false && first.issues.map((i) => i.path)).toEqual([
      'sandbox.ro_binds[0]',
      'sandbox.ro_binds[0]',
    ]);
    const plain = write(
      'agent.yaml',
      'db: state.db\ntasks: tasks.yaml\ndefaults: { agent: { connector: codex } }\nconnectors:\n  - { name: codex, exec: [codex-acp], transport: acp }\n',
    );
    expect(checkConfigFile(plain).every((c) => c.ok)).toBe(true);
  });
});

describe('ConnectorManifest with managed_by: systemd', () => {
  const UNIT = { name: 'webhook', exec: ['247-agent-connector-webhook'], managed_by: 'systemd' };

  it('defaults to core and derives the socket of a unit with ops', () => {
    const core = parseManifest({ name: 'x', exec: ['x'] }, '/x/c.yaml');
    expect(core.ok && core.config.managed_by).toBe('core');
    const r = parseManifest(UNIT, '/x/c.yaml');
    expect(r.ok && r.config).toMatchObject({ managed_by: 'systemd', transport: 'stdio' });
    expect(r.ok && unitSocket(r.config)).toBe('/run/247-agent-connector/webhook/mcp.sock');
    expect(unitSocket({ name: 'w', socket: '/srv/w.sock' })).toBe('/srv/w.sock');
    expect(issues({ ...UNIT, transport: 'none' })).toEqual([]);
    expect(issues({ ...UNIT, socket: '/srv/w.sock', health: { interval: '1m' } })).toEqual([]);
  });

  it('refuses built-ins, acp agents, sandboxes and misplaced sockets', () => {
    expect(issues({ ...POLLER, managed_by: 'systemd' })).toContain(
      'managed_by: a built-in connector runs inside the core; it has no unit',
    );
    expect(issues({ ...UNIT, transport: 'acp' })).toContain(
      'managed_by: an acp agent runs as a child of the core (use sandbox: bwrap to confine it)',
    );
    expect(issues({ name: 'x', exec: ['x'], socket: '/s.sock' })).toEqual([
      'socket: socket is where a managed_by: systemd connector serves its ops; this one is spawned by the core',
    ]);
    expect(issues({ ...UNIT, socket: 'rel.sock' })).toEqual([
      'socket: socket must be an absolute path',
    ]);
    expect(issues({ ...UNIT, transport: 'none', socket: '/s.sock' })).toEqual([
      'socket: a "none" connector serves no ops: it has no socket',
    ]);
  });
});
