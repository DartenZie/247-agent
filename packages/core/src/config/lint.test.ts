import { describe, expect, it } from 'vitest';

import { lintTasks } from './lint.js';
import { TasksFile } from './schema.js';

describe('lintTasks', () => {
  it('lints every filter and when of a task, naming the task', () => {
    const { tasks } = TasksFile.parse({
      tasks: [
        {
          name: 'publish',
          trigger: { kind: 'event', type: 'approval.answered', filter: 'payload.ok == true' },
          action: { kind: 'wait', for: { type: 'x.y', filter: "payload.n > '1'" } },
          emit: [{ type: 'a.b', when: 'result.x == null' }],
        },
        {
          name: 'steps',
          trigger: { kind: 'manual' },
          action: {
            kind: 'sequence',
            steps: [
              { kind: 'wait', for: { type: 'x.y', filter: "payload.n < '2'" } },
              { kind: 'shell', cmd: ['true'], when: 'steps[0].payload.ok == false' },
            ],
          },
        },
        {
          name: 'fix',
          trigger: { kind: 'manual' },
          action: {
            kind: 'agent',
            workspace: { kind: 'temp' },
            tools: ['read'],
            prompt: 'fix it',
            post: [{ shell: ['make', 'test'], when: "result.files > '0'" }],
          },
        },
        {
          name: 'clean',
          trigger: { kind: 'event', type: 'a.c', filter: 'payload.ok == `true`' },
          action: { kind: 'shell', cmd: ['true'] },
        },
      ],
    });
    const issues = lintTasks(tasks);
    expect(issues.map((i) => i.path)).toEqual([
      'tasks[0].trigger.filter',
      'tasks[0].emit[0].when',
      'tasks[0].action.for.filter',
      'tasks[1].action.steps[0].for.filter',
      'tasks[1].action.steps[1].when',
      'tasks[2].action.post[0].when',
    ]);
    expect(issues[0]?.message).toBe(
      'task "publish": payload.ok == true: true here is a field named "true", not the literal; write `true`',
    );
  });
});
