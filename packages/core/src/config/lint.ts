import { compileTypePattern } from '../expr/glob.js';
import { lintJmespath, parseJmespath, unplace } from '../expr/jmespath.js';
import { expressionRoots, forEachTemplate, parseTemplate } from '../expr/template.js';
import { formatPath, type ConfigIssue } from './load.js';
import type { TaskConfig } from './schema.js';
import { taskActions } from './walk.js';

/** One lint finding: the task it is in, the issue path, what is wrong. */
export interface TaskWarning {
  task: string;
  path: string;
  message: string;
}

/**
 * Warnings, not errors: expressions that are valid but almost certainly wrong
 * (`lintJmespath`). Linted are every bare JMESPath a task holds (the trigger `filter`, each
 * `emit` rule's `when`, each sequence step's `when`, each `agent` post gate's `when`), the
 * expression inside every `${…}` template of its `action`, `emit` rules and
 * `state_updates` (the strings the schema checks as templates), and each `wait`'s
 * `for.filter` as a whole, with every template in it standing in as a placeholder
 * (`lintWaitFilter`). Also every event cycle between the tasks of `all` (the whole config,
 * `tasks` by default), reported at the trigger of its first task when that task is in
 * `tasks` (`eventCycles`).
 */
export function lintTasks(
  tasks: readonly TaskConfig[],
  all: readonly TaskConfig[] = tasks,
): TaskWarning[] {
  const out: TaskWarning[] = [];
  const index = new Map(tasks.map((t, i) => [t.name, i]));
  for (const cycle of eventCycles(all)) {
    const [first] = cycle;
    const i = first === undefined ? undefined : index.get(first.task);
    if (first === undefined || i === undefined) {
      continue;
    }
    const hops = cycle.map(
      (h, k) => `${h.task} emits "${h.type}" to ${(cycle[k + 1] ?? first).task}`,
    );
    out.push({
      task: first.task,
      path: `tasks[${String(i)}].trigger`,
      message:
        `event cycle: ${hops.join(', ')}; each run can start the next until ` +
        'limits.max_event_depth or limits.max_runs_per_chain drops the chain, unless a ' +
        'trigger filter ends it',
    });
  }
  tasks.forEach((task, i) => {
    const at = `tasks[${String(i)}]`;
    const add = (path: string, messages: readonly string[]): void => {
      for (const message of messages) {
        out.push({ task: task.name, path, message });
      }
    };
    const bare = (expr: string | undefined, path: string, roots: readonly string[]): void => {
      if (expr !== undefined) {
        add(path, [...lintJmespath(expr), ...lintRoots(expr, roots)]);
      }
    };
    /**
     * Each `${…}` expression of every template inside `value`, with the roots at its path;
     * `undefined` roots for a field that is never rendered.
     */
    const templates = (
      value: unknown,
      base: string,
      roots: (sub: readonly (string | number)[]) => readonly string[] | undefined,
    ): void => {
      forEachTemplate(value, (text, sub) => {
        const at = roots(sub);
        add(
          `${base}.${formatPath(sub)}`,
          templateExprs(text).flatMap((e) => [
            ...lintJmespath(e),
            ...(at === undefined ? [] : lintRoots(e, at)),
          ]),
        );
      });
    };

    if (task.trigger.kind === 'event') {
      bare(task.trigger.filter, `${at}.trigger.filter`, EVENT_FIELDS);
    }
    const inAction = task.action.kind === 'sequence' ? SEQUENCE_ROOTS : ACTION_ROOTS;
    for (const { action, at: actionAt } of taskActions(task, `${at}.action`)) {
      if ('when' in action) {
        bare(action.when, `${actionAt}.when`, inAction);
      }
      if (action.kind === 'wait' && action.for.filter !== undefined) {
        add(`${actionAt}.for.filter`, lintWaitFilter(action.for.filter));
      } else if (action.kind === 'agent') {
        action.post.forEach((gate, g) => {
          bare(gate.when, `${actionAt}.post[${String(g)}].when`, POST_ROOTS);
        });
      }
    }
    templates(task.action, `${at}.action`, (sub) => {
      const a = task.action;
      const step = a.kind === 'sequence' ? a.steps[Number(sub[1])] : undefined;
      const [kind, field] = step === undefined ? [a.kind, sub[0]] : [step.kind, sub[2]];
      if (!RENDERED[kind].includes(String(field))) {
        return undefined;
      }
      return kind === 'agent' && field === 'post' ? POST_ROOTS : inAction;
    });
    task.emit?.forEach((rule, j) => {
      const ruleAt = `${at}.emit[${String(j)}]`;
      bare(rule.when, `${ruleAt}.when`, ROUTING_ROOTS);
      templates(
        { each: rule.each, dedup_key: rule.dedup_key, payload: rule.payload },
        ruleAt,
        (sub) => (rule.each !== undefined && sub[0] !== 'each' ? EACH_ROOTS : ROUTING_ROOTS),
      );
    });
    if (task.state_updates !== undefined) {
      templates(task.state_updates, `${at}.state_updates`, () => ROUTING_ROOTS);
    }
  });
  return out;
}

/** `lintTasks` as issues for `oa validate`, each message naming its task. */
export function lintIssues(
  tasks: readonly TaskConfig[],
  all: readonly TaskConfig[] = tasks,
): ConfigIssue[] {
  return lintTasks(tasks, all).map((w) => ({
    path: w.path,
    message: `task "${w.task}": ${w.message}`,
  }));
}

/** One hop of an event cycle: `task` produces `type`, which triggers the next hop's task. */
export interface CycleHop {
  task: string;
  type: string;
}

/**
 * Cycles in the static graph from what a task's runs publish (its `emit` types and
 * `task.<name>.succeeded|failed|cancelled`) to the event triggers whose `type` or
 * `type_any` match it. Filters are ignored: they may end a cycle at run time, which only
 * the author can tell. A task never triggers on its own events, so a cycle has at least
 * two tasks. One cycle per strongly connected group: the shortest through the group's
 * task that comes first in `tasks`, starting there. Other cycles of the group go unnamed.
 */
export function eventCycles(tasks: readonly TaskConfig[]): CycleHop[][] {
  const triggers = tasks.map((t) => {
    if (t.trigger.kind !== 'event') {
      return [];
    }
    const patterns = t.trigger.type !== undefined ? [t.trigger.type] : (t.trigger.type_any ?? []);
    return patterns.map(compileTypePattern);
  });
  /** `edges[from]`: each task `to` it triggers, with the first type that does. */
  const edges = tasks.map((from, f) => {
    const produced = [
      ...(from.emit ?? []).map((r) => r.type),
      `task.${from.name}.succeeded`,
      `task.${from.name}.failed`,
      `task.${from.name}.cancelled`,
    ];
    const out: { to: number; type: string }[] = [];
    triggers.forEach((matchers, to) => {
      const type = to === f ? undefined : produced.find((p) => matchers.some((m) => m(p)));
      if (type !== undefined) {
        out.push({ to, type });
      }
    });
    return out;
  });
  /** Shortest paths from `start` within `allowed`: each reached node's previous hop. */
  const search = (start: number, allowed: (n: number) => boolean): Map<number, number> => {
    const prev = new Map<number, number>();
    const queue = [start];
    // An array iterator also visits what is pushed during the loop: a breadth-first queue.
    for (const n of queue) {
      for (const e of edges[n] ?? []) {
        if (!prev.has(e.to) && allowed(e.to)) {
          prev.set(e.to, n);
          queue.push(e.to);
        }
      }
    }
    return prev;
  };
  const reach = tasks.map((_, n) => search(n, () => true));
  const grouped = new Set<number>();
  const cycles: CycleHop[][] = [];
  tasks.forEach((_, v) => {
    if (grouped.has(v) || !(reach[v]?.has(v) ?? false)) {
      return;
    }
    const group = new Set(
      tasks.flatMap((__, u) =>
        (reach[v]?.has(u) ?? false) && (reach[u]?.has(v) ?? false) ? [u] : [],
      ),
    );
    group.forEach((u) => grouped.add(u));
    const prev = search(v, (n) => group.has(n));
    const path: number[] = [];
    for (let n = prev.get(v) ?? v; n !== v; n = prev.get(n) ?? v) {
      path.unshift(n);
    }
    path.unshift(v);
    cycles.push(
      path.map((n, k) => {
        const to = path[k + 1] ?? v;
        return {
          task: tasks[n]?.name ?? '',
          type: edges[n]?.find((e) => e.to === to)?.type ?? '',
        };
      }),
    );
  });
  return cycles;
}

/**
 * What an expression can read, by where it stands (docs/internal/actions.md). A trigger
 * filter and the bare part of a `wait` filter see the event itself; templates and `when`s
 * see the scope the executor and the runners build for that position.
 */
const EVENT_FIELDS = [
  'id',
  'type',
  'source',
  'ts',
  'correlation_id',
  'parent_id',
  'dedup_key',
  'depth',
  'payload',
];
const ACTION_ROOTS = ['event', 'state', 'secrets', 'env', 'run'];
const SEQUENCE_ROOTS = [...ACTION_ROOTS, 'steps'];
/** An `agent` post gate runs with the agent's result added to the action's scope. */
const POST_ROOTS = [...ACTION_ROOTS, 'result'];
/** `emit` and `state_updates`. */
const ROUTING_ROOTS = ['event', 'result', 'state', 'env', 'run'];
const EACH_ROOTS = [...ROUTING_ROOTS, 'item'];
/**
 * The fields each runner renders. Others reach the runner as written (an `llm`'s
 * `output_schema`), so a `${…}` in them is text and its roots are never read.
 */
const RENDERED: Record<TaskConfig['action']['kind'], readonly string[]> = {
  shell: ['cmd', 'cwd', 'env', 'stdin'],
  connector: ['args'],
  wait: ['for'],
  sequence: [],
  llm: ['input'],
  decide: ['state'],
  agent: ['prompt', 'post'],
};
const SCOPE_ROOTS = [...ACTION_ROOTS, 'result', 'item', 'steps'];

/**
 * A root of `expr` that is not in `roots` reads as null at run time, which is never what
 * was meant: a typo (`evnt`, `results`), a name of another position (`steps` in `emit`,
 * `result` in an action) or a scope name in a filter that sees the event (`event.payload`).
 * Each is named once per expression with what to write instead.
 */
function lintRoots(expr: string, roots: readonly string[]): string[] {
  const available = new Set(roots);
  return [...expressionRoots(expr)]
    .filter((r) => !available.has(r) && !LITERAL_LIKE.test(r) && !r.startsWith(PLACEHOLDER))
    .map(
      (r) => `${expr}: "${r}" is not available here, so it reads as null; ${rootHint(r, roots)}`,
    );
}

/**
 * What `root` was probably meant as: itself when it is a name of some other position, else
 * the nearest name (available here first, then the scope's, then the event's fields) within
 * an edit distance of a third of its length, at most 2. Then what to write for that name.
 */
function rootHint(root: string, roots: readonly string[]): string {
  const event = roots === EVENT_FIELDS;
  const known = [...roots, ...SCOPE_ROOTS, ...(event ? [] : EVENT_FIELDS)];
  const near = known.includes(root)
    ? root
    : known.find((n) => editDistance(root, n) <= Math.min(2, Math.floor(root.length / 3)));
  if (near === undefined) {
    return `the names available here are ${roots.join(', ')}`;
  }
  const meant = `did you mean "${near}"?`;
  if (roots.includes(near)) {
    return meant;
  }
  const hint = elsewhere(near, event, roots.includes('result'));
  return near === root ? hint : `${meant} ${hint}`;
}

/** Where `name`, which is not available here, can be used instead. */
function elsewhere(name: string, event: boolean, result: boolean): string {
  if (event) {
    return name === 'event'
      ? 'this filter sees the event itself: write payload.x, not event.payload.x'
      : `this filter sees only the event's fields: ${EVENT_FIELDS.join(', ')}`;
  }
  switch (name) {
    case 'steps':
      return result
        ? 'steps exists only inside a sequence; after it, the step results are result.steps, as in result.steps[0]'
        : 'steps exists only inside a sequence';
    case 'result':
      return "result exists only in emit, state_updates and an agent's post gates";
    case 'item':
      return 'item exists only in the payload and dedup_key of an emit rule with each';
    case 'secrets':
      return 'secrets can be used only inside action';
    default:
      return `the trigger event is under event: write event.${name}`;
  }
}

/** Levenshtein distance, for the "did you mean" of a mistyped root. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const PLACEHOLDER = '__oa_tpl_';
/** Fields named like a literal (`true`, `"1"`): `lintJmespath` says what to write instead. */
const LITERAL_LIKE = /^(?:true|false|null|-?\d+(?:\.\d+)?)$/;

/** The expressions of a template; none when it does not parse (the schema reports that). */
function templateExprs(text: string): string[] {
  try {
    return parseTemplate(text).flatMap((p) => ('expr' in p ? [p.expr] : []));
  } catch {
    return [];
  }
}

/**
 * A `wait` filter is rendered (`expr/filter-template.ts`) and parsed only when the run
 * suspends, each `${…}` value landing in the JMESPath as data. The filter as written is
 * linted with each template replaced by an identifier, which parses wherever a value may
 * stand. A filter that does not parse even so is reported too: at run time the
 * dispatcher cannot compile it and the wait never matches.
 */
function lintWaitFilter(filter: string): string[] {
  let parts;
  try {
    parts = parseTemplate(filter);
  } catch {
    return []; // the schema reports a broken template
  }
  const placeholders = new Map<string, string>();
  const text = parts
    .map((p) => {
      if ('text' in p) {
        return p.text;
      }
      const placeholder = `${PLACEHOLDER}${String(placeholders.size)}__`;
      placeholders.set(placeholder, `\${${p.expr}}`);
      return placeholder;
    })
    .join('');
  const p = parseJmespath(text);
  if (!p.ok) {
    const error = unplace(p.message, placeholders);
    return [
      placeholders.size === 0
        ? `${filter}: not valid JMESPath, so the wait never matches an event: ${error}`
        : `${filter}: not valid JMESPath even with each \${…} standing for a value; the wait matches only if what it renders to parses: ${error}`,
    ];
  }
  return [
    ...lintJmespath(text, { placeholders }),
    ...lintRoots(text, EVENT_FIELDS).map((m) => unplace(m, placeholders)),
  ];
}
