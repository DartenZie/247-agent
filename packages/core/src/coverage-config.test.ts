import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
// A computed specifier keeps tsc from pulling the root config into this package.
const config = (
  (await import(pathToFileURL(`${root}vitest.config.js`).href)) as {
    default: { test?: { coverage?: unknown } };
  }
).default;
const coverage = (config.test?.coverage ?? {}) as {
  provider?: string;
  include?: string[];
  exclude?: string[];
  thresholds?: unknown;
};

function workspaces(): string[] {
  return ['packages', 'connectors'].flatMap((dir) =>
    readdirSync(`${root}${dir}`, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${dir}/${d.name}`),
  );
}

describe('coverage', () => {
  it('has an npm script that runs the suite with coverage', () => {
    expect(pkg.scripts['test:coverage']).toMatch(/vitest run .*--coverage/);
  });

  it('installs the v8 provider with npm install', () => {
    expect(coverage.provider).toBe('v8');
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBeDefined();
    const require = createRequire(`${root}package.json`);
    expect(() => require.resolve('@vitest/coverage-v8/package.json')).not.toThrow();
  });

  it('reports every workspace package and leaves tests out', () => {
    expect(coverage.include).toEqual(['packages/*/src/**/*.ts', 'connectors/*/src/**/*.ts']);
    for (const ws of workspaces()) {
      expect(existsSync(`${root}${ws}/src`), `${ws}/src`).toBe(true);
    }
    expect(coverage.exclude).toEqual(
      expect.arrayContaining([
        '**/*.test.ts',
        '**/test-helpers.ts',
        'packages/core/src/**/testing.ts',
      ]),
    );
  });

  it('records that CI enforces no threshold', () => {
    expect(coverage.thresholds).toBeUndefined();
  });
});
