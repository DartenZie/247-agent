import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/pack-release.sh', import.meta.url));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-pack-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Entry {
  name: string;
  uid: number;
  gid: number;
  uname: string;
  gname: string;
}

/** The ustar headers of a .tar.gz, without the pax and GNU long-name records. */
function entries(tarball: string): Entry[] {
  const tar = gunzipSync(readFileSync(tarball));
  const field = (h: Buffer, at: number, len: number): string =>
    h
      .subarray(at, at + len)
      .toString('utf8')
      .replace(/\0.*$/s, '')
      .trim();
  const out: Entry[] = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) {
      break;
    }
    const size = parseInt(field(h, 124, 12) || '0', 8);
    const type = field(h, 156, 1);
    if (!['x', 'g', 'L', 'K'].includes(type)) {
      out.push({
        name: field(h, 0, 100),
        uid: parseInt(field(h, 108, 8), 8),
        gid: parseInt(field(h, 116, 8), 8),
        uname: field(h, 265, 32),
        gname: field(h, 297, 32),
      });
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe.skipIf(process.platform === 'win32')('pack-release.sh', () => {
  it('records every entry as owned by root, not by the build user', () => {
    const tree = join(root, '247-agent-9.9.9');
    mkdirSync(join(tree, 'bin'), { recursive: true });
    writeFileSync(join(tree, 'VERSION'), 'version=9.9.9\n');
    writeFileSync(join(tree, 'bin', 'oa'), '#!/bin/sh\n');
    symlinkSync('oa', join(tree, 'bin', 'link'));

    const run = spawnSync('sh', [script, root, '247-agent-9.9.9'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    const listed = entries(join(root, '247-agent-9.9.9.tar.gz'));
    expect(listed.length).toBeGreaterThanOrEqual(5);
    for (const e of listed) {
      expect({ name: e.name, uid: e.uid, gid: e.gid }).toEqual({ name: e.name, uid: 0, gid: 0 });
      expect(['', 'root'], e.name).toContain(e.uname);
      expect(['', 'root'], e.name).toContain(e.gname);
    }
  });
});
