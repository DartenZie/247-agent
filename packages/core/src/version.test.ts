import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VERSION } from './version.js';

describe('VERSION', () => {
  it('matches the root package.json', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
