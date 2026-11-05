import { describe, expect, it } from 'vitest';

import { formatLoadResult } from './format.js';
import { loadTasksFile, parseTasks } from './load.js';

const EXAMPLE = new URL('../../../../docs/examples/website-updates.yaml', import.meta.url).pathname;

describe('loadTasksFile', () => {
  it('loads the reference workflow', () => {
    const r = loadTasksFile(EXAMPLE);
    expect(formatLoadResult(r)).toEqual([`ok ${EXAMPLE} (9 tasks)`]);
    if (r.ok) {
      expect(r.config.tasks.map((t) => t.trigger.kind)).toEqual([
        'cron',
        'event',
        'event',
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
      expect.stringMatching(/^x\.yaml:3: tasks\[0\]\.trigger\.type_any\[1\]: task "a": /),
      expect.stringMatching(/^x\.yaml:3: tasks\[0\]\.trigger\.filter: task "a": invalid JMESPath/),
    ]);
  });
});

describe('issue locations', () => {
  const TEXT = [
    'tasks:', // 1
    '  - name: good', // 2
    '    trigger: { kind: manual }', // 3
    '    action: { kind: shell, cmd: ["true"] }', // 4
    '  - name: needs_secret', // 5
    '    trigger:', // 6
    '      kind: event', // 7
    '      type: x.y', // 8
    '      filter: "#TOKEN"', // 9
    '    action:', // 10
    '      kind: shell', // 11
    '      cmd: ["true"]', // 12
    '  - name: no_action', // 13
    '    trigger: { kind: manual }', // 14
    '',
  ].join('\n');

  it('names the task and the line of the offending key of each schema issue', () => {
    const r = parseTasks(TEXT, 'x.yaml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues).toEqual([
      {
        path: 'tasks[1].trigger.filter',
        task: 'needs_secret',
        line: 9,
        message: expect.stringMatching(/^invalid JMESPath/) as string,
      },
      {
        path: 'tasks[2].action',
        task: 'no_action',
        line: 13,
        message: expect.any(String) as string,
      },
    ]);
    expect(formatLoadResult(r)[0]).toMatch(
      /^x\.yaml:9: tasks\[1\]\.trigger\.filter: task "needs_secret": invalid JMESPath/,
    );
  });

  it('gives a line but no task when the entry has no usable name', () => {
    const r = parseTasks(
      'tasks:\n  - name: 5\n    trigger: { kind: manual }\n    action: { kind: shell, cmd: ["true"] }\n',
      'x.yaml',
    );
    expect(!r.ok && r.issues).toEqual([
      { path: 'tasks[0].name', line: 2, message: expect.any(String) as string },
    ]);
    expect(formatLoadResult(r)[0]).toMatch(/^x\.yaml:2: tasks\[0\]\.name: /);
  });
});
