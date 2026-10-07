import { compile, search } from 'jmespath';

/** A compiled trigger filter. `evaluate` may throw on runtime type errors. */
export interface Filter {
  readonly expr: string;
  evaluate(data: unknown): boolean;
}

export class FilterSyntaxError extends Error {
  constructor(
    readonly expr: string,
    cause: unknown,
  ) {
    super(`invalid JMESPath "${expr}": ${syntaxMessage(cause)}`);
    this.name = 'FilterSyntaxError';
  }
}

/**
 * JMESPath truthiness: `null`, `false`, empty string, empty array and empty object are
 * false; everything else, including `0`, is true.
 */
export function isJmesTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') {
    return false;
  }
  if (Array.isArray(v)) {
    return v.length > 0;
  }
  if (typeof v === 'object') {
    return Object.keys(v).length > 0;
  }
  return true;
}

/**
 * The parser's message, with a hint for the commonest mistake: a bare number such as
 * `payload.amount > 100`, which JMESPath reads as an index token, not a literal.
 */
function syntaxMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const number = /Invalid token \(Number\): "(-?\d+)"/.exec(message)?.[1];
  return number === undefined
    ? message
    : `${message}; a number literal needs backticks, as in \`${number}\``;
}

/** Returns an error message, or null when `expr` parses. */
export function validateJmespath(expr: string): string | null {
  try {
    compile(expr);
    return null;
  } catch (err) {
    return syntaxMessage(err);
  }
}

/** The parts of a jmespath.js AST node the lint reads. */
interface JmesNode {
  type: string;
  name?: unknown;
  value?: unknown;
  children?: unknown;
}

function isNode(v: unknown): v is JmesNode {
  return v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

function childrenOf(node: JmesNode): JmesNode[] {
  return Array.isArray(node.children) ? node.children.filter(isNode) : [];
}

const COMPARATORS: Record<string, string> = {
  EQ: '==',
  NE: '!=',
  LT: '<',
  LTE: '<=',
  GT: '>',
  GTE: '>=',
};
const ORDERING = new Set(['LT', 'LTE', 'GT', 'GTE']);
const BARE_LITERALS = new Set(['true', 'false', 'null']);
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** An operand as written, near enough to recognise: `payload.amount`, `'100'`, `true`. */
function render(node: JmesNode): string {
  if (node.type === 'Field' && typeof node.name === 'string') {
    return node.name;
  }
  if (node.type === 'Subexpression') {
    return childrenOf(node).map(render).join('.');
  }
  if (node.type === 'IndexExpression') {
    const [base, index] = childrenOf(node);
    if (base !== undefined && index?.type === 'Index' && typeof index.value === 'number') {
      return `${render(base)}[${String(index.value)}]`;
    }
  }
  if (node.type === 'Function' && typeof node.name === 'string') {
    return `${node.name}(${childrenOf(node).map(render).join(', ')})`;
  }
  if (node.type === 'Current') {
    return '@';
  }
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? `'${node.value}'` : `\`${JSON.stringify(node.value)}\``;
  }
  return '…';
}

/**
 * Comparisons in a valid expression that almost certainly do not mean what they say, one
 * message per suspect operand; empty when `expr` does not parse. Two shapes:
 *
 * - a bare `true`, `false` or `null` operand: JMESPath reads it as a field of that name,
 *   which is null, so `payload.approved == true` matches when `approved` is missing and
 *   never when it is true;
 * - an ordering comparison (`<`, `<=`, `>`, `>=`) with a quoted number: the JMESPath spec
 *   orders numbers only (jmespath.js happens to coerce), so `payload.amount > '100'`
 *   depends on the library and turns lexical when the field holds a string.
 *
 * `==` with a quoted number is left alone: it is right when the field holds a string.
 */
export function lintJmespath(expr: string): string[] {
  let ast: unknown;
  try {
    ast = compile(expr);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: JmesNode): void => {
    const sides = childrenOf(node);
    const op = typeof node.name === 'string' ? COMPARATORS[node.name] : undefined;
    const [left, right] = sides;
    if (
      node.type === 'Comparator' &&
      op !== undefined &&
      left !== undefined &&
      right !== undefined
    ) {
      const text = `${render(left)} ${op} ${render(right)}`;
      for (const side of [left, right]) {
        if (
          side.type === 'Field' &&
          typeof side.name === 'string' &&
          BARE_LITERALS.has(side.name)
        ) {
          out.push(
            `${text}: ${side.name} here is a field named "${side.name}", not the literal; write \`${side.name}\``,
          );
        } else if (
          ORDERING.has(String(node.name)) &&
          side.type === 'Literal' &&
          typeof side.value === 'string' &&
          NUMERIC.test(side.value)
        ) {
          out.push(
            `${text}: '${side.value}' is a string and JMESPath orders only numbers; write \`${side.value}\``,
          );
        }
      }
    }
    sides.forEach(visit);
  };
  if (isNode(ast)) {
    visit(ast);
  }
  return out;
}

/**
 * Parses once to fail fast on syntax errors. Evaluation re-parses via `search` because the
 * `jmespath` package exposes no interpreter over a pre-built AST; expressions are short.
 */
export function compileFilter(expr: string): Filter {
  try {
    compile(expr);
  } catch (err) {
    throw new FilterSyntaxError(expr, err);
  }
  return {
    expr,
    evaluate: (data) => isJmesTruthy(search(data, expr)),
  };
}
