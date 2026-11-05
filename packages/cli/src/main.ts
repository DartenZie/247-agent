#!/usr/bin/env node
import { errorMessage } from '@247-agent/core';

import { main } from './cli.js';
import { EXIT, exitOnClosedPipe } from './io.js';

exitOnClosedPipe([process.stdout, process.stderr], (code) => process.exit(code));

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`oa: ${errorMessage(err)}\n`);
    process.exitCode = EXIT.failed;
  },
);
