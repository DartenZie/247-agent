import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const target = `${process.platform}-${process.arch}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-install-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A release tarball with only what install.sh reads: VERSION and the two launchers. Its
 * entries are closed to other users, as a release built under umask 077 records them.
 */
function fakeRelease(): string {
  const tree = join(root, 'src', '247-agent-9.9.9');
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'VERSION'), `version=9.9.9\ntarget=${target}\nnode=22\n`);
  chmodSync(tree, 0o700);
  chmodSync(join(tree, 'bin'), 0o700);
  chmodSync(join(tree, 'VERSION'), 0o600);
  for (const name of ['247-agent-core', 'oa']) {
    writeFileSync(join(tree, 'bin', name), '#!/bin/sh\necho 9.9.9\n');
    chmodSync(join(tree, 'bin', name), 0o700);
  }
  const tarball = join(root, 'release.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'src'), '247-agent-9.9.9']);
  expect(tar.status).toBe(0);
  return tarball;
}

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('installs a tree other users can run from a closed tarball under a restrictive umask', () => {
    const prefix = join(root, 'opt', '247-agent');
    const run = spawnSync(
      'sh',
      [
        '-c',
        'umask 077; exec sh "$@"',
        'sh',
        script,
        '--from',
        fakeRelease(),
        '--prefix',
        prefix,
        '--bin-dir',
        join(root, 'bin'),
        '--no-service',
      ],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const tree = `${prefix}-9.9.9`;
    for (const path of [tree, join(tree, 'bin'), join(tree, 'bin', '247-agent-core')]) {
      expect(statSync(path).mode & 0o777, path).toBe(0o755);
    }
    expect(statSync(join(tree, 'VERSION')).mode & 0o777).toBe(0o644);
  });
});
