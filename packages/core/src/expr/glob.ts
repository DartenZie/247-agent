/**
 * Event type patterns: dot-separated segments where `*` matches exactly one non-empty
 * segment. `task.*.failed` matches `task.notify.failed` but not `task.a.b.failed` or
 * `task.failed`. There is no `**` and no partial wildcard like `task.fail*`.
 */

const SEGMENT = /^[a-z0-9_-]+$/;
const MAX_SEGMENTS = 8;

export type TypeMatcher = (type: string) => boolean;

/** Returns an error message, or null when `pattern` is a valid type pattern. */
export function validateTypePattern(
  pattern: string,
  opts: { allowWildcard: boolean },
): string | null {
  const segments = pattern.split('.');
  if (segments.length > MAX_SEGMENTS) {
    return `too many segments (max ${String(MAX_SEGMENTS)})`;
  }
  for (const seg of segments) {
    if (seg === '*') {
      if (!opts.allowWildcard) {
        return 'wildcards are not allowed in emitted event types';
      }
      continue;
    }
    if (!SEGMENT.test(seg)) {
      return `invalid segment "${seg}" (allowed: a-z, 0-9, "_", "-", or "*" for one segment)`;
    }
  }
  return null;
}

export function isTypePattern(s: string): boolean {
  return s.includes('*');
}

/** Compiles a validated pattern into a predicate. Exact strings compare with `===`. */
export function compileTypePattern(pattern: string): TypeMatcher {
  if (!isTypePattern(pattern)) {
    return (type) => type === pattern;
  }
  const source = pattern
    .split('.')
    .map((seg) => (seg === '*' ? '[^.]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('\\.');
  const re = new RegExp(`^${source}$`);
  return (type) => re.test(type);
}
