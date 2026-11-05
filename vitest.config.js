import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests in other packages exercise the core's sources, not its `dist/`.
    alias: {
      '@247-agent/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'connectors/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // `npm run test:coverage` writes a text summary to the terminal and an HTML and
    // lcov report to `coverage/`. CI enforces no threshold: the report is for
    // finding gaps, and a gate would fail on refactors that move code without
    // losing tests. Add `thresholds` here if that changes.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'connectors/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test-helpers.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // A failing test still leaves a report to read.
      reportOnFailure: true,
    },
  },
});
