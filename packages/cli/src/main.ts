#!/usr/bin/env node
import { main } from './cli.js';
import { EXIT } from './io.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`oa: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT.failed;
  },
);
