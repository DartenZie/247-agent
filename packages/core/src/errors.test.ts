import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { errorMessage } from './errors.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every non-test `.ts` file under `dir`, repo-relative. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => relative(ROOT, join(ROOT, dir, f)));
}

describe('errorMessage', () => {
  it('returns an Error message and stringifies anything else', () => {
    expect(errorMessage(new TypeError('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('is the only copy in the core and the CLI', () => {
    const inline = /(\b[\w.]+) instanceof Error \? \1\.message : String\(\1\)/;
    const offenders = [...sources('packages/core/src'), ...sources('packages/cli/src')].filter(
      (file) => {
        if (file === join('packages', 'core', 'src', 'errors.ts')) {
          return false;
        }
        const text = readFileSync(join(ROOT, file), 'utf8');
        return text.includes('function errorMessage(') || inline.test(text);
      },
    );
    expect(offenders).toEqual([]);
  });
});
