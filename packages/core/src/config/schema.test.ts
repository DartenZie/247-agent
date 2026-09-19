import { describe, expect, it } from 'vitest';

import { TasksFile } from './schema.js';

const action = { kind: 'shell', cmd: ['true'] };

function issues(input: unknown): { path: string; message: string }[] {
  const r = TasksFile.safeParse(input);
  if (r.success) {
    return [];
  }
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function withTask(task: Record<string, unknown>): unknown {
  return { tasks: [{ name: 'a', action, ...task }] };
}

describe('TasksFile schema', () => {
  it('accepts minimal cron, event and manual tasks and applies defaults', () => {
    const r = TasksFile.safeParse({
      tasks: [
        { name: 'c', trigger: { kind: 'cron', schedule: '*/5 * * * *' }, action },
        { name: 'e', trigger: { kind: 'event', type: 'email.received' }, action },
        { name: 'm', trigger: { kind: 'manual' }, action },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tasks[0]?.concurrency).toBe(1);
      expect(r.data.tasks[0]?.trigger).toEqual({
        kind: 'cron',
        schedule: '*/5 * * * *',
        overlap: 'skip',
      });
    }
  });

  it('rejects invalid cron expressions, never-firing schedules and unknown time zones', () => {
    expect(issues(withTask({ trigger: { kind: 'cron', schedule: '61 * * * *' } }))).toEqual([
      {
        path: 'tasks.0.trigger.schedule',
        message: expect.stringMatching(/Invalid value for minute/) as string,
      },
    ]);
    expect(
      issues(withTask({ trigger: { kind: 'cron', schedule: '0 0 30 2 *' } }))[0]?.message,
    ).toMatch(/never fires/);
    expect(
      issues(withTask({ trigger: { kind: 'cron', schedule: '* * * * *', tz: 'Nope/Zone' } })),
    ).toEqual([
      { path: 'tasks.0.trigger.tz', message: expect.stringMatching(/unknown time zone/) as string },
    ]);
    expect(
      issues(withTask({ trigger: { kind: 'cron', schedule: '0 9 * * *', tz: 'Europe/Prague' } })),
    ).toEqual([]);
  });

  it('requires exactly one of type and type_any', () => {
    expect(issues(withTask({ trigger: { kind: 'event' } }))[0]?.message).toMatch(/exactly one/);
    expect(
      issues(withTask({ trigger: { kind: 'event', type: 'a.b', type_any: ['c.d'] } }))[0]?.message,
    ).toMatch(/exactly one/);
  });

  it('rejects bad type patterns with a precise path', () => {
    expect(issues(withTask({ trigger: { kind: 'event', type: 'task.**' } }))[0]?.path).toBe(
      'tasks.0.trigger.type',
    );
    expect(
      issues(withTask({ trigger: { kind: 'event', type_any: ['ok.fine', 'task.fail*'] } }))[0]
        ?.path,
    ).toBe('tasks.0.trigger.type_any.1');
  });

  it('rejects invalid filters', () => {
    expect(
      issues(withTask({ trigger: { kind: 'event', type: 'a.b', filter: 'payload.x ==' } })),
    ).toEqual([
      {
        path: 'tasks.0.trigger.filter',
        message: expect.stringMatching(/invalid JMESPath/) as string,
      },
    ]);
  });

  it('rejects duplicate names, unknown keys, bad names and bad durations', () => {
    expect(
      issues({
        tasks: [
          { name: 'a', trigger: { kind: 'manual' }, action },
          { name: 'a', trigger: { kind: 'manual' }, action },
        ],
      }),
    ).toEqual([{ path: 'tasks.1.name', message: expect.stringMatching(/duplicate/) as string }]);
    expect(issues(withTask({ trigger: { kind: 'manual' }, trigers: 1 }))[0]?.message).toMatch(
      /Unrecognized key/,
    );
    expect(
      issues({ tasks: [{ name: 'Bad-Name', trigger: { kind: 'manual' }, action }] })[0]?.path,
    ).toBe('tasks.0.name');
    expect(issues(withTask({ trigger: { kind: 'manual' }, timeout: '5 minutes' }))[0]?.path).toBe(
      'tasks.0.timeout',
    );
    expect(
      issues(withTask({ trigger: { kind: 'manual' }, action: { kind: 'teleport' } }))[0]?.path,
    ).toBe('tasks.0.action.kind');
  });

  it('rejects a task that listens to its own lifecycle events', () => {
    expect(
      issues({
        tasks: [{ name: 'notify', trigger: { kind: 'event', type: 'task.notify.failed' }, action }],
      }),
    ).toEqual([
      { path: 'tasks.0.trigger.type', message: expect.stringMatching(/its own/) as string },
    ]);
    expect(
      issues({
        tasks: [
          { name: 'notify', trigger: { kind: 'event', type_any: ['task.*.failed'] }, action },
        ],
      }),
    ).toEqual([]);
  });
});
