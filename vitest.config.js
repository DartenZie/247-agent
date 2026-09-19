import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests in other packages exercise the core's sources, not its `dist/`.
    alias: {
      '@online-agent/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'connectors/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
