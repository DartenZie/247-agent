import { checkConfigFile, formatCheck, formatWarnings } from '@247-agent/core';

import { EXIT, UsageError, type Io } from '../io.js';

export const VALIDATE_USAGE = `usage: oa validate <file>...

Validates tasks files and agent.yaml files against the schema. An agent.yaml also has its
referenced tasks file checked. Warnings (a filter comparison that cannot mean what it
says) are printed but do not fail the file.
`;

export function validate(args: string[], io: Io): number {
  // A leading `--` ends the options, so a file may start with a dash (`oa validate -- -x`).
  const files = args[0] === '--' ? args.slice(1) : args;
  if (files.length === 0) {
    throw new UsageError('validate: at least one file is required');
  }
  let failed = false;
  for (const file of files) {
    for (const check of checkConfigFile(file)) {
      for (const line of formatCheck(check)) {
        if (check.ok) {
          io.out(line);
        } else {
          io.err(line);
        }
      }
      for (const line of formatWarnings(check)) {
        io.err(line);
      }
      failed ||= !check.ok;
    }
  }
  return failed ? EXIT.failed : EXIT.ok;
}
