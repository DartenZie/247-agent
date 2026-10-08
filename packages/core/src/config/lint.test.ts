import { describe, expect, it } from 'vitest';

import { lintIssues, lintTasks } from './lint.js';
import { TasksFile } from './schema.js';

const parse = (tasks: unknown[]) => TasksFile.parse({ tasks }).tasks;

describe('lintTasks', () => {
  it('lints every filter and when of a task, naming the task', () => {
    const tasks = parse([
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
    ]);
    expect(lintTasks(tasks).map((w) => [w.task, w.path])).toEqual([
      ['publish', 'tasks[0].trigger.filter'],
      ['publish', 'tasks[0].action.for.filter'],
      ['publish', 'tasks[0].emit[0].when'],
      ['steps', 'tasks[1].action.steps[0].for.filter'],
      ['steps', 'tasks[1].action.steps[1].when'],
      ['fix', 'tasks[2].action.post[0].when'],
    ]);
    expect(lintIssues(tasks)[0]?.message).toBe(
      'task "publish": payload.ok == true: true here is a field named "true", not the literal; write `true`',
    );
  });

  it('lints the expression inside every ${…} template, with the path of its string', () => {
    const tasks = parse([
      {
        name: 'templated',
        trigger: { kind: 'manual' },
        action: {
          kind: 'sequence',
          steps: [
            { kind: 'shell', cmd: ['echo', 'ok=${event.payload.ok == true}'] },
            {
              kind: 'connector',
              connector: 'chat',
              op: 'send',
              args: { text: "${ steps[0] > '3' }", nested: [{ x: '${event.payload.y != null}' }] },
            },
          ],
        },
        emit: [
          {
            type: 'a.b',
            each: '${ result.steps[?ok == false] }',
            dedup_key: 'k-${event.id}',
            payload: { flag: '${ result.x == true }' },
          },
        ],
        state_updates: { 'site.flag': '${ result.x == null }' },
      },
      {
        name: 'prompt',
        trigger: { kind: 'manual' },
        action: { kind: 'llm', input: 'Is it ${ event.payload.urgent == true }?' },
      },
    ]);
    expect(lintTasks(tasks).map((w) => w.path)).toEqual([
      'tasks[0].action.steps[0].cmd[1]',
      'tasks[0].action.steps[1].args.text',
      'tasks[0].action.steps[1].args.nested[0].x',
      'tasks[0].emit[0].each',
      'tasks[0].emit[0].payload.flag',
      'tasks[0].state_updates.site.flag',
      'tasks[1].action.input',
    ]);
    expect(lintTasks(tasks)[1]?.message).toBe(
      "steps[0] > '3': '3' is a string and JMESPath orders only numbers; write `3`",
    );
  });

  it('lints a wait filter around its templates, each standing for a value', () => {
    const wait = (filter: string) =>
      parse([
        {
          name: 'w',
          trigger: { kind: 'manual' },
          action: { kind: 'wait', for: { type: 'x.y', filter } },
        },
      ]);
    // A bare template renders as a JSON literal of its value: nothing to say.
    expect(lintTasks(wait('payload.ok == ${event.payload.want}'))).toEqual([]);
    expect(lintTasks(wait("payload.ok == ${event.payload.want} && payload.n > '1'"))).toEqual([
      {
        task: 'w',
        path: 'tasks[0].action.for.filter',
        message: "payload.n > '1': '1' is a string and JMESPath orders only numbers; write `1`",
      },
    ]);
    // The expression inside the template and the filter around it are both linted.
    expect(
      lintTasks(
        wait("correlation_id == '${event.correlation_id}' && payload.ok == true && ${a == null}"),
      ).map((w) => w.message.split(':')[0]),
    ).toEqual(['payload.ok == true', 'a == null']);
    // Quoted the way the docs show: nothing to say.
    expect(lintTasks(wait("correlation_id == '${event.correlation_id}'"))).toEqual([]);
    expect(lintTasks(wait('payload.n > `${event.payload.min}`'))).toEqual([]);
  });

  it('never skips a wait filter that does not parse', () => {
    const wait = (filter: string) =>
      lintTasks(
        parse([
          {
            name: 'w',
            trigger: { kind: 'manual' },
            action: { kind: 'wait', for: { type: 'x.y', filter } },
          },
        ]),
      ).map((w) => w.message);
    expect(wait('payload.ok ==')).toEqual([
      'payload.ok ==: not valid JMESPath, so the wait never matches an event: Invalid token (EOF): ""',
    ]);
    expect(wait('payload.n > -${event.payload.n}')).toEqual([
      expect.stringMatching(
        /^payload\.n > -\$\{event\.payload\.n\}: not valid JMESPath even with each \$\{…\} standing for a value/,
      ) as string,
    ]);
  });
});
