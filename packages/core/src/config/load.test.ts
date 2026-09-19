import { describe, expect, it } from 'vitest';

import { formatLoadResult } from './format.js';
import { loadTasksFile, parseTasks } from './load.js';

const EXAMPLE = new URL('../../../../docs/examples/orchestra-website.yaml', import.meta.url)
  .pathname;

describe('loadTasksFile', () => {
  it('loads the reference workflow', () => {
    const r = loadTasksFile(EXAMPLE);
    expect(formatLoadResult(r)).toEqual([`ok ${EXAMPLE} (7 tasks)`]);
    if (r.ok) {
      expect(r.config.tasks.map((t) => t.trigger.kind)).toEqual([
        'cron',
        'event',
        'event',
        'event',
        'event',
        'event',
        'event',
      ]);
    }
  });

  it('reports a missing file as one issue', () => {
    const r = loadTasksFile('/nonexistent/tasks.yaml');
    expect(r.ok).toBe(false);
    expect(formatLoadResult(r)).toEqual([expect.stringMatching(/cannot read file/)]);
  });
});

describe('parseTasks', () => {
  it('reports YAML syntax errors as one issue', () => {
    const r = parseTasks('tasks: [', 'x.yaml');
    expect(formatLoadResult(r)).toEqual([expect.stringMatching(/^x\.yaml: YAML syntax error/)]);
  });

  it('formats schema issues with indexed paths', () => {
    const r = parseTasks(
      'tasks:\n  - name: a\n    trigger: { kind: event, type_any: [ok, "bad*"] , filter: "x ==" }\n    action: { kind: shell, cmd: ["true"] }\n',
      'x.yaml',
    );
    expect(formatLoadResult(r)).toEqual([
      expect.stringMatching(/^x\.yaml: tasks\[0\]\.trigger\.type_any\[1\]: /),
      expect.stringMatching(/^x\.yaml: tasks\[0\]\.trigger\.filter: invalid JMESPath/),
    ]);
  });
});
