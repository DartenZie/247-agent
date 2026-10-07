import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findHome, homeEnv } from './home.js';

describe('findHome', () => {
  let root: string;
  beforeEach(() => {
    // realpath: macOS puts the temp dir behind a symlink and findHome resolves it.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oa-home-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers $OA_HOME', () => {
    expect(findHome({ OA_HOME: '/opt/247-agent' }, '/elsewhere/lib/core.mjs')).toBe(
      '/opt/247-agent',
    );
  });

  it('walks up from the main script to the directory holding bin/247-agent-core, if any', () => {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', '247-agent-core'), '#!/bin/sh\n');
    const script = join(root, 'packages', 'core', 'dist', 'main.js');
    mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(script, '');
    expect(findHome({ OA_HOME: '' }, script)).toBe(root);
    expect(findHome({}, join(root, 'lib', 'core.mjs'))).toBe(root);
    rmSync(join(root, 'bin'), { recursive: true });
    expect(findHome({}, join(root, 'lib', 'core.mjs'))).toBeUndefined();
    expect(findHome({}, undefined)).toBeUndefined();
  });
});

describe('homeEnv', () => {
  it('puts <home>/bin and the Node directory first on PATH, once', () => {
    const out = homeEnv(
      '/opt/247-agent',
      { PATH: '/usr/bin:/opt/247-agent/bin:/bin' },
      '/opt/247-agent/node/bin/node',
    );
    expect(out).toEqual({
      OA_HOME: '/opt/247-agent',
      PATH: '/opt/247-agent/bin:/opt/247-agent/node/bin:/usr/bin:/bin',
    });
  });

  it('copes with an empty PATH', () => {
    expect(homeEnv('/h', {}, '/n/bin/node').PATH).toBe('/h/bin:/n/bin');
  });
});
