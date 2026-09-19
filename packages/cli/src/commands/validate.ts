import { checkConfigFile, formatCheck } from '@online-agent/core';

import { EXIT, UsageError, type Io } from '../io.js';

export const VALIDATE_USAGE = `usage: oa validate <file>...

Validates tasks files and agent.yaml files against the schema. An agent.yaml also has its
referenced tasks file checked.
`;

export function validate(files: string[], io: Io): number {
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
      failed ||= !check.ok;
    }
  }
  return failed ? EXIT.failed : EXIT.ok;
}
