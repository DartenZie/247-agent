import { describe, expect, it } from 'vitest';

import type { ConnectorConfig } from '../config/connector.js';
import type { TaskConfig } from '../config/schema.js';
import type { SandboxConfig } from './sandbox.js';
import { BWRAP_PROBE_ARGV, bwrapUsers, probeBwrap, type ProbeRun } from './bwrap-probe.js';

const ok: ProbeRun = () => Promise.resolve({ status: 0, stderr: '' });
const failing =
  (stderr: string): ProbeRun =>
  () =>
    Promise.resolve({ status: 1, stderr });
const noSysctl = () => undefined;

describe('probeBwrap', () => {
  it('runs a minimal sandbox and reports ok when it exits 0', async () => {
    const seen: string[][] = [];
    const result = await probeBwrap({
      run: (argv) => {
        seen.push([...argv]);
        return ok(argv);
      },
      readSysctl: noSysctl,
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([[...BWRAP_PROBE_ARGV]]);
    expect(BWRAP_PROBE_ARGV).toEqual([
      'bwrap',
      '--unshare-pid',
      '--unshare-ipc',
      '--ro-bind',
      '/',
      '/',
      'true',
    ]);
  });

  it('names a missing bwrap', async () => {
    const result = await probeBwrap({
      run: () =>
        Promise.resolve({
          error: Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' }),
        }),
      readSysctl: noSysctl,
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.cause).toMatch(/bwrap is not installed.*apt install bubblewrap/);
  });

  it('names the Ubuntu AppArmor user-namespace restriction', async () => {
    const result = await probeBwrap({
      run: failing('bwrap: setting up uid map: Permission denied\n'),
      readSysctl: (name) =>
        name === 'kernel.apparmor_restrict_unprivileged_userns' ? '1' : undefined,
    });
    expect(!result.ok && result.cause).toMatch(/kernel\.apparmor_restrict_unprivileged_userns=1/);
    expect(!result.ok && result.cause).toMatch(/AppArmor profile/);
    expect(!result.ok && result.cause).toMatch(/setting up uid map: Permission denied/);
  });

  it('does not blame AppArmor for a failure that is not about user namespaces', async () => {
    const result = await probeBwrap({
      run: failing('bwrap: Unexpected capabilities but not setuid, old file caps config?'),
      readSysctl: (name) =>
        name === 'kernel.apparmor_restrict_unprivileged_userns' ? '1' : undefined,
    });
    expect(!result.ok && result.cause).not.toMatch(/AppArmor/);
    expect(!result.ok && result.cause).toMatch(/check by hand/);
  });

  it('names the Debian unprivileged_userns_clone switch', async () => {
    const result = await probeBwrap({
      run: failing('bwrap: No permissions to creating new namespace'),
      readSysctl: (name) => (name === 'kernel.unprivileged_userns_clone' ? '0' : undefined),
    });
    expect(!result.ok && result.cause).toMatch(/kernel\.unprivileged_userns_clone=0/);
  });

  it('names user.max_user_namespaces=0', async () => {
    const result = await probeBwrap({
      run: failing('bwrap: No permissions to creating new namespace'),
      readSysctl: (name) => (name === 'user.max_user_namespaces' ? '0' : undefined),
    });
    expect(!result.ok && result.cause).toMatch(/user\.max_user_namespaces=0/);
  });

  it("falls back to bwrap's own message and the manual check", async () => {
    const result = await probeBwrap({ run: failing('bwrap: something odd'), readSysctl: noSysctl });
    expect(!result.ok && result.cause).toMatch(/bwrap: something odd/);
    expect(!result.ok && result.cause).toMatch(
      /bwrap --unshare-pid --unshare-ipc --ro-bind \/ \/ true/,
    );
  });
});

const shellTask = (name: string, sandbox?: unknown): TaskConfig =>
  ({
    name,
    trigger: { manual: true },
    action: { kind: 'shell', cmd: ['true'], ...(sandbox === undefined ? {} : { sandbox }) },
  }) as unknown as TaskConfig;

const bwrap: SandboxConfig = { backend: 'bwrap', extra_args: [], ro_binds: [], rw_binds: [] };
const none: SandboxConfig = { ...bwrap, backend: 'none' };

describe('bwrapUsers', () => {
  it('lists shell tasks, sequence steps and acp connectors in bwrap', () => {
    const tasks = [
      shellTask('plain'),
      shellTask('boxed', bwrap),
      shellTask('unboxed', none),
      {
        name: 'seq',
        trigger: { manual: true },
        action: { kind: 'sequence', steps: [{ kind: 'shell', cmd: ['true'], sandbox: bwrap }] },
      } as unknown as TaskConfig,
    ];
    const manifests = [
      { name: 'claude', transport: 'acp', sandbox: bwrap },
      { name: 'codex', transport: 'acp', sandbox: none },
      { name: 'mail', transport: 'stdio' },
    ] as unknown as ConnectorConfig[];
    expect(bwrapUsers(tasks, undefined, manifests)).toEqual([
      'task boxed',
      'task seq',
      'connector claude',
    ]);
  });

  it('counts a shell action without its own sandbox under defaults.sandbox', () => {
    expect(bwrapUsers([shellTask('plain'), shellTask('unboxed', none)], bwrap, [])).toEqual([
      'task plain',
    ]);
    expect(bwrapUsers([shellTask('plain')], none, [])).toEqual([]);
  });
});
