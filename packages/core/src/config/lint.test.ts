import { describe, expect, it } from 'vitest';

import { eventCycles, lintIssues, lintTasks } from './lint.js';
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

  it('flags a root that is not available where it stands, with what to write', () => {
    const tasks = parse([
      {
        name: 'digest',
        trigger: { kind: 'event', type: 'a.b', filter: "event.payload.x == 'y' && paylod.z" },
        action: {
          kind: 'sequence',
          steps: [
            { kind: 'shell', cmd: ['echo', '${evnt.payload.x}', '${steps[0]}', 'h=${HOME}'] },
            {
              kind: 'wait',
              for: { type: 'c.d', filter: "correlation_id == '${steps[0].id}' && evnt.x" },
            },
            { kind: 'shell', cmd: ['echo', '${result.x}'], when: 'results.ok' },
          ],
        },
        emit: [
          {
            type: 'e.f',
            when: 'length(steps[0].emails) > `0`',
            payload: { kind: '${reslt.kind}', item: '${item}' },
          },
          { type: 'e.g', each: '${result.list}', payload: { id: '${item.id}', p: '${payload}' } },
        ],
        state_updates: { 'digest.last_uid': '${steps[0].last_uid}' },
      },
      {
        name: 'fix',
        trigger: { kind: 'manual' },
        action: {
          kind: 'agent',
          workspace: { kind: 'temp' },
          tools: ['read'],
          prompt: 'fix ${result.x} in ${sort_by(event.payload.files, &name)[0].name}',
          post: [{ shell: ['test', '${result.status}'], when: "result.status == 'done'" }],
        },
      },
      {
        name: 'draft',
        trigger: { kind: 'manual' },
        action: {
          kind: 'llm',
          input: 'draft it',
          output_schema: {
            type: 'object',
            properties: { body: { type: 'string', description: 'keep ${name} as written' } },
          },
        },
      },
    ]);
    expect(lintTasks(tasks).map((w) => [w.path, w.message])).toEqual([
      [
        'tasks[0].trigger.filter',
        'event.payload.x == \'y\' && paylod.z: "event" is not available here, so it reads as null; this filter sees the event itself: write payload.x, not event.payload.x',
      ],
      [
        'tasks[0].trigger.filter',
        'event.payload.x == \'y\' && paylod.z: "paylod" is not available here, so it reads as null; did you mean "payload"?',
      ],
      [
        'tasks[0].action.steps[1].for.filter',
        'correlation_id == \'${steps[0].id}\' && evnt.x: "evnt" is not available here, so it reads as null; did you mean "event"? this filter sees the event itself: write payload.x, not event.payload.x',
      ],
      [
        'tasks[0].action.steps[2].when',
        'results.ok: "results" is not available here, so it reads as null; did you mean "result"? result exists only in emit, state_updates and an agent\'s post gates',
      ],
      [
        'tasks[0].action.steps[0].cmd[1]',
        'evnt.payload.x: "evnt" is not available here, so it reads as null; did you mean "event"?',
      ],
      [
        'tasks[0].action.steps[0].cmd[3]',
        'HOME: "HOME" is not available here, so it reads as null; the names available here are event, state, secrets, env, run, steps; a literal ${HOME} is written $${HOME}',
      ],
      [
        'tasks[0].action.steps[2].cmd[1]',
        'result.x: "result" is not available here, so it reads as null; result exists only in emit, state_updates and an agent\'s post gates',
      ],
      [
        'tasks[0].emit[0].when',
        'length(steps[0].emails) > `0`: "steps" is not available here, so it reads as null; steps exists only inside a sequence; after it, the step results are result.steps, as in result.steps[0]',
      ],
      [
        'tasks[0].emit[0].payload.kind',
        'reslt.kind: "reslt" is not available here, so it reads as null; did you mean "result"?',
      ],
      [
        'tasks[0].emit[0].payload.item',
        'item: "item" is not available here, so it reads as null; item exists only in the payload and dedup_key of an emit rule with each',
      ],
      [
        'tasks[0].emit[1].payload.p',
        'payload: "payload" is not available here, so it reads as null; the trigger event is under event: write event.payload',
      ],
      [
        'tasks[0].state_updates.digest.last_uid',
        'steps[0].last_uid: "steps" is not available here, so it reads as null; steps exists only inside a sequence; after it, the step results are result.steps, as in result.steps[0]',
      ],
      [
        'tasks[1].action.prompt',
        'result.x: "result" is not available here, so it reads as null; result exists only in emit, state_updates and an agent\'s post gates',
      ],
    ]);
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
        wait(
          "correlation_id == '${event.correlation_id}' && payload.ok == true && ${event.a == null}",
        ),
      ).map((w) => w.message.split(':')[0]),
    ).toEqual(['payload.ok == true', 'event.a == null']);
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

describe('eventCycles', () => {
  const sh = { kind: 'shell', cmd: ['true'] };
  const on = (name: string, type: string | string[], emits: string[] = []) => ({
    name,
    trigger: { kind: 'event', ...(Array.isArray(type) ? { type_any: type } : { type }) },
    action: sh,
    ...(emits.length === 0 ? {} : { emit: emits.map((t) => ({ type: t })) }),
  });

  it('finds a cycle through emit rules and one through lifecycle events, once each', () => {
    const tasks = parse([
      { name: 'start', trigger: { kind: 'manual' }, action: sh, emit: [{ type: 'x.ping' }] },
      on('ping', 'x.ping', ['x.pong']),
      on('pong', 'x.*', ['x.ping', 'y.done']),
      on('tail', 'y.done'),
      on('after_a', 'task.after_b.succeeded'),
      on('after_b', ['task.after_a.*', 'z.never']),
    ]);
    expect(eventCycles(tasks)).toEqual([
      [
        { task: 'ping', type: 'x.pong' },
        { task: 'pong', type: 'x.ping' },
      ],
      [
        { task: 'after_a', type: 'task.after_a.succeeded' },
        { task: 'after_b', type: 'task.after_b.succeeded' },
      ],
    ]);
    expect(lintIssues(tasks).filter((i) => i.path.endsWith('.trigger'))).toEqual([
      {
        path: 'tasks[1].trigger',
        message:
          'task "ping": event cycle: ping emits "x.pong" to pong, pong emits "x.ping" to ping; ' +
          'each run can start the next until limits.max_event_depth or ' +
          'limits.max_runs_per_chain drops the chain, unless a trigger filter ends it',
      },
      expect.objectContaining({ path: 'tasks[4].trigger' }),
    ]);
  });

  it('reports the shortest cycle through the first task of a group and ignores a task triggering on its own events', () => {
    const tasks = parse([
      on('a', 'e.a', ['e.b', 'e.a']),
      on('b', 'e.b', ['e.c']),
      on('c', 'e.c', ['e.a', 'e.b']),
      on('self', 'task.*.failed'),
    ]);
    expect(eventCycles(tasks).map((c) => c.map((h) => h.task))).toEqual([['a', 'b', 'c']]);
    expect(eventCycles(parse([on('self', 'task.*.failed')]))).toEqual([]);
  });

  it('sees a cycle across files and reports it in the file of its first task', () => {
    const one = parse([on('ping', 'x.ping', ['x.pong'])]);
    const two = parse([on('pong', 'x.pong', ['x.ping'])]);
    const all = [...one, ...two];
    expect(lintTasks(one)).toEqual([]);
    expect(lintTasks(one, all).map((w) => [w.task, w.path])).toEqual([
      ['ping', 'tasks[0].trigger'],
    ]);
    expect(lintTasks(two, all)).toEqual([]);
  });
});
