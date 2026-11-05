import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

import type { ConfigIssue } from './load.js';

/** One path segment of an issue path: a key or a list index. */
const SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

function segments(path: string): (string | number)[] {
  return [...path.matchAll(SEGMENT)].map((m) => (m[2] === undefined ? (m[1] ?? '') : Number(m[2])));
}

/**
 * Adds to each issue of a tasks file the name of the task its path is in (`task`, when the
 * entry has a string `name`) and the 1-based line of the deepest node of its path the
 * text holds (`line`): the key itself for a mapping entry, the item for a list entry, so a
 * missing key points at the entry that lacks it. An issue whose path the text does not hold
 * at all, or a text that does not parse, is returned as it is.
 */
export function locateIssues(text: string, issues: readonly ConfigIssue[]): ConfigIssue[] {
  if (issues.every((i) => i.path === '')) {
    return [...issues];
  }
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (doc.errors.length > 0) {
    return [...issues];
  }
  const lineAt = (offset: number): number => counter.linePos(offset).line;
  return issues.map((issue) => {
    let node: unknown = doc.contents;
    let line: number | undefined;
    let task: string | undefined;
    const path = segments(issue.path);
    for (const [k, seg] of path.entries()) {
      if (typeof seg === 'number' && isSeq(node)) {
        const item: unknown = node.items[seg];
        if (!isNode(item)) {
          break;
        }
        line = lineAt(item.range?.[0] ?? 0);
        node = item;
        if (k === 1 && path[0] === 'tasks' && isMap(item)) {
          const name = item.get('name');
          task = typeof name === 'string' ? name : undefined;
        }
      } else if (typeof seg === 'string' && isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && p.key.value === seg);
        if (pair === undefined || !isNode(pair.key)) {
          break;
        }
        line = lineAt(pair.key.range?.[0] ?? 0);
        node = pair.value;
      } else {
        break;
      }
    }
    return {
      ...issue,
      ...(task === undefined ? {} : { task }),
      ...(line === undefined ? {} : { line }),
    };
  });
}

function isNode(x: unknown): x is Node {
  return isMap(x) || isSeq(x) || isScalar(x);
}
