// Bundles every program of a release into one file each with esbuild (called by
// scripts/build-release.sh): the daemon, the oa command and the bundled connectors.
// Output is ESM (`.mjs`); the only thing left outside is better-sqlite3, whose native
// addon the release ships under node_modules/. The banner gives bundled CommonJS
// dependencies the `require`, `__filename` and `__dirname` they expect.
//
//   node scripts/bundle.mjs <out-dir>
import process from 'node:process';

import { build } from 'esbuild';

const PROGRAMS = {
  core: 'packages/core/src/main.ts',
  oa: 'packages/cli/src/main.ts',
  'connector-email': 'connectors/email/src/main.ts',
  'connector-ftp': 'connectors/ftp/src/main.ts',
  'connector-chat': 'connectors/chat/src/main.ts',
  'connector-webhook': 'connectors/webhook/src/main.ts',
};

const BANNER = [
  "import { createRequire as __oaCreateRequire } from 'node:module';",
  "import { fileURLToPath as __oaFileURLToPath } from 'node:url';",
  "import { dirname as __oaDirname } from 'node:path';",
  'const require = __oaCreateRequire(import.meta.url);',
  'const __filename = __oaFileURLToPath(import.meta.url);',
  'const __dirname = __oaDirname(__filename);',
].join('\n');

const outdir = process.argv[2];
if (outdir === undefined) {
  process.stderr.write('usage: node scripts/bundle.mjs <out-dir>\n');
  process.exit(2);
}

await build({
  entryPoints: PROGRAMS,
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3', '*.node'],
  banner: { js: BANNER },
  legalComments: 'linked',
  logLevel: 'warning',
});
