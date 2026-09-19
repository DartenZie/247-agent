import type { LoadResult } from './load.js';

/** One line per issue: `<file>: <path>: <message>`, or a single `ok` line. */
export function formatLoadResult(result: LoadResult): string[] {
  if (result.ok) {
    return [`ok ${result.file} (${String(result.config.tasks.length)} tasks)`];
  }
  return result.issues.map((i) =>
    i.path === '' ? `${result.file}: ${i.message}` : `${result.file}: ${i.path}: ${i.message}`,
  );
}
