import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeToOthers, mkdirPrivate } from './private-fs.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-private-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mkdirPrivate', () => {
  it('creates missing directories 0750 under a permissive umask', () => {
    const prev = process.umask(0o022);
    try {
      const dir = join(root, 'a', 'b');
      mkdirPrivate(dir);
      expect(statSync(join(root, 'a')).mode & 0o777).toBe(0o750);
      expect(statSync(dir).mode & 0o777).toBe(0o750);
    } finally {
      process.umask(prev);
    }
  });

  it('clears the other-user bits of an existing directory and keeps the rest', () => {
    const dir = join(root, 'old');
    mkdirSync(dir);
    chmodSync(dir, 0o775);
    mkdirPrivate(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o770);
  });
});

describe('closeToOthers', () => {
  it('leaves a missing path alone', () => {
    expect(() => {
      closeToOthers(join(root, 'missing'));
    }).not.toThrow();
  });

  it('clears the other-user bits of a file', () => {
    const file = join(root, 'f');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    closeToOthers(file);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});
