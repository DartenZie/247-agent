import type { ConfigIssue, LoadResult } from './load.js';

/** One line per issue (`formatIssue`), or a single `ok` line. */
export function formatLoadResult(result: LoadResult): string[] {
  if (result.ok) {
    return [`ok ${result.file} (${String(result.config.tasks.length)} tasks)`];
  }
  return result.issues.map((i) => formatIssue(result.file, i));
}

/**
 * One issue as `<file>[:<line>]: [<path>: ][<prefix>][task "<name>": ]<message>`, the line
 * and task when the issue carries them. `prefix` is `warning: ` for a lint finding.
 */
export function formatIssue(file: string, issue: ConfigIssue, prefix = ''): string {
  const at = issue.line === undefined ? file : `${file}:${String(issue.line)}`;
  const path = issue.path === '' ? '' : `${issue.path}: `;
  const task = issue.task === undefined ? '' : `task "${issue.task}": `;
  return `${at}: ${path}${prefix}${task}${issue.message}`;
}
