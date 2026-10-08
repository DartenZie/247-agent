import { compile, search, tokenize } from 'jmespath';

/** A compiled trigger filter. `evaluate` may throw on runtime type errors. */
export interface Filter {
  readonly expr: string;
  evaluate(data: unknown): boolean;
}

export class FilterSyntaxError extends Error {
  constructor(
    readonly expr: string,
    message: string,
  ) {
    super(`invalid JMESPath "${expr}": ${message}`);
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

/** A jmespath.js AST node, as far as this module reads it. */
export interface JmesNode {
  type: string;
  name?: unknown;
  value?: unknown;
  children?: unknown;
}

export type ParsedJmespath = { ok: true; ast: JmesNode } | { ok: false; message: string };

const parsed = new Map<string, ParsedJmespath>();

/**
 * Parses `expr` once per process: the schema's validation, the lint, `compileFilter` and
 * the template compiler all read the same cached result. The message of a failure carries
 * the bare-number hint.
 */
export function parseJmespath(expr: string): ParsedJmespath {
  let p = parsed.get(expr);
  if (p === undefined) {
    try {
      p = { ok: true, ast: compile(expr) as JmesNode };
    } catch (err) {
      p = { ok: false, message: syntaxMessage(expr, err) };
    }
    if (parsed.size > 10_000) {
      parsed.clear();
    }
    parsed.set(expr, p);
  }
  return p;
}

interface Token {
  type: string;
  value: unknown;
  start: number;
}

function tokens(expr: string): Token[] | undefined {
  try {
    return tokenize(expr);
  } catch {
    return undefined;
  }
}

const NUMBER_TOKEN = /Invalid token \(Number\): "(-?\d+)"/;
const NUMBER_AS_WRITTEN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * The parser's message, with a hint for the commonest mistake: a bare number such as
 * `payload.amount > 100`, which JMESPath reads as an index token, not a literal. The lexer
 * keeps only the integer part (`100.5` is the token `100`), so the hint quotes the number
 * from the source text, or no number when that is not valid JSON.
 */
function syntaxMessage(expr: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lexed = NUMBER_TOKEN.exec(message)?.[1];
  if (lexed === undefined) {
    return message;
  }
  const written = bareNumber(expr, lexed);
  return written === undefined
    ? `${message}; a number literal needs backticks`
    : `${message}; a number literal needs backticks, as in \`${written}\``;
}

/** The first number token outside an index or a slice, as written in `expr`. */
function bareNumber(expr: string, lexed: string): string | undefined {
  const list = tokens(expr) ?? [];
  const at = list.find(
    (t, i) =>
      t.type === 'Number' &&
      String(t.value) === lexed &&
      list[i - 1]?.type !== 'Lbracket' &&
      list[i - 1]?.type !== 'Colon',
  );
  const written = at === undefined ? undefined : NUMBER_AS_WRITTEN.exec(expr.slice(at.start))?.[0];
  return written !== undefined && JSON_NUMBER.test(written) ? written : undefined;
}

/** Returns an error message, or null when `expr` parses. */
export function validateJmespath(expr: string): string | null {
  const p = parseJmespath(expr);
  return p.ok ? null : p.message;
}

function isNode(v: unknown): v is JmesNode {
  return v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

/**
 * The sub-expressions of a node, in source order. Every jmespath.js 0.16 node type is
 * covered: `KeyValuePair` keeps its expression in `value`; `FilterProjection` stores
 * `[left, right, condition]` for `left[?condition].right`; `Slice` holds numbers and
 * `Literal` a JSON value that may itself look like a node, so neither is descended into.
 */
function childrenOf(node: JmesNode): JmesNode[] {
  const kids = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  switch (node.type) {
    case 'KeyValuePair':
      return isNode(node.value) ? [node.value] : [];
    case 'FilterProjection': {
      const [left, right, condition] = kids;
      return [left, condition, right].filter(isNode);
    }
    case 'Literal':
    case 'Field':
    case 'Index':
    case 'Slice':
    case 'Identity':
    case 'Current':
      return [];
    default:
      // Subexpression, IndexExpression, Projection, ValueProjection, Flatten, Pipe,
      // OrExpression, AndExpression, NotExpression, Comparator, Function,
      // ExpressionReference, MultiSelectList, MultiSelectHash.
      return kids.filter(isNode);
  }
}

/** How a `Field` or `Literal` node was written: its token's text in the source. */
interface Written {
  text: string;
  /** A `"double-quoted"` identifier. */
  quoted: boolean;
}

const NAMED_TOKENS = new Set(['UnquotedIdentifier', 'QuotedIdentifier', 'Literal']);
const IDENTIFIER_TOKENS = ['UnquotedIdentifier', 'QuotedIdentifier'];

/**
 * Lines up the identifier and literal tokens of `expr` with the AST walked in source order
 * (a `Field`, a function name, a hash key and a `Literal` each take one), so a node can be
 * echoed as the user wrote it. Empty when the two do not line up.
 */
function writtenForms(expr: string, ast: JmesNode): Map<JmesNode, Written> {
  const all = tokens(expr);
  if (all === undefined) {
    return new Map();
  }
  const named = all
    .map((t, i) => ({
      t,
      text: expr.slice(t.start, all[i + 1]?.start ?? expr.length).trimEnd(),
    }))
    .filter((x) => NAMED_TOKENS.has(x.t.type));
  const out = new Map<JmesNode, Written>();
  let k = 0;
  /** Takes the next token when it has one of `types` and holds `value`. */
  const take = (types: readonly string[], value: unknown): Written | undefined => {
    const next = named[k];
    if (
      next === undefined ||
      !types.includes(next.t.type) ||
      JSON.stringify(next.t.value) !== JSON.stringify(value)
    ) {
      return undefined;
    }
    k++;
    return { text: next.text, quoted: next.t.type === 'QuotedIdentifier' };
  };
  /** False as soon as a node finds no matching token. */
  const walk = (node: JmesNode): boolean => {
    if (node.type === 'Field' || node.type === 'Literal') {
      const w =
        node.type === 'Field' ? take(IDENTIFIER_TOKENS, node.name) : take(['Literal'], node.value);
      if (w === undefined) {
        return false;
      }
      out.set(node, w);
      return true;
    }
    if (node.type === 'Function' && take(['UnquotedIdentifier'], node.name) === undefined) {
      return false;
    }
    if (node.type === 'KeyValuePair' && take(IDENTIFIER_TOKENS, node.name) === undefined) {
      return false;
    }
    return childrenOf(node).every(walk);
  };
  return walk(ast) && k === named.length ? out : new Map<JmesNode, Written>();
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
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An expression as written: source text for fields and literals, the AST around them. */
function render(node: JmesNode, written: Map<JmesNode, Written>): string {
  const kids = childrenOf(node);
  const r = (n: JmesNode | undefined): string => (n === undefined ? '' : render(n, written));
  switch (node.type) {
    case 'Field': {
      const name = String(node.name);
      return written.get(node)?.text ?? (IDENTIFIER.test(name) ? name : JSON.stringify(name));
    }
    case 'Literal':
      return (
        written.get(node)?.text ??
        (typeof node.value === 'string'
          ? `'${node.value.replaceAll("'", "\\'")}'`
          : `\`${JSON.stringify(node.value)}\``)
      );
    case 'Subexpression':
      return kids.map(r).join('.');
    case 'IndexExpression': {
      const [base, index] = kids;
      return index?.type === 'Index' ? `${r(base)}[${String(index.value)}]` : `${r(base)}[…]`;
    }
    case 'Function':
      return `${String(node.name)}(${kids.map(r).join(', ')})`;
    case 'Comparator':
      return `${r(kids[0])} ${COMPARATORS[String(node.name)] ?? '?'} ${r(kids[1])}`;
    case 'NotExpression':
      return `!${r(kids[0])}`;
    case 'Current':
      return '@';
    default:
      return '…';
  }
}

/** What a quoted identifier holding a literal's text was probably meant to be. */
function meantAs(name: string): string | undefined {
  if (name === 'true' || name === 'false') {
    return 'the boolean';
  }
  if (name === 'null') {
    return 'null';
  }
  return NUMERIC.test(name) ? 'the number' : undefined;
}

export interface LintOptions {
  /**
   * Identifiers standing in for `${…}` templates of a filter that is rendered as text
   * before it is parsed (a `wait`'s `for.filter`), mapped to the template as written.
   */
  placeholders?: ReadonlyMap<string, string>;
}

/**
 * Comparisons in a valid expression that almost certainly do not mean what they say, one
 * message per suspect operand; empty when `expr` does not parse. The shapes:
 *
 * - a bare `true`, `false` or `null` operand: JMESPath reads it as a field of that name,
 *   which is null, so `payload.approved == true` matches when `approved` is missing and
 *   never when it is true;
 * - a double-quoted `"true"`, `"false"`, `"null"` or number: a quoted identifier, so a
 *   field again, most likely meant as the string `'true'`;
 * - an ordering comparison (`<`, `<=`, `>`, `>=`) with a quoted number: the JMESPath spec
 *   orders numbers only (jmespath.js happens to coerce), so `payload.amount > '100'`
 *   depends on the library and turns lexical when the field holds a string;
 * - with `placeholders`, a template rendered unquoted as an operand: its value lands in the
 *   filter as plain text, so a string or a boolean becomes a field and a number breaks it.
 *
 * `==` with a quoted number is left alone: it is right when the field holds a string.
 * Operands are echoed as written, with each placeholder shown as its template.
 */
export function lintJmespath(expr: string, opts: LintOptions = {}): string[] {
  const p = parseJmespath(expr);
  if (!p.ok) {
    return [];
  }
  const placeholders = opts.placeholders ?? new Map<string, string>();
  let written: Map<JmesNode, Written> | undefined;
  /** Computed only once something is flagged. */
  const forms = (): Map<JmesNode, Written> => (written ??= writtenForms(expr, p.ast));
  /** The complaint about one operand of the comparison `cmp`, or undefined. */
  const suspect = (cmp: JmesNode, side: JmesNode): string | undefined => {
    if (side.type === 'Field' && typeof side.name === 'string') {
      const name = side.name;
      const template = placeholders.get(name);
      if (template !== undefined) {
        return `${template} is rendered into the filter as plain text, so a string or true/false/null becomes a field name and a number breaks the filter; write '${template}' for a string or \`${template}\` for a number or boolean`;
      }
      const meant = meantAs(name);
      const w = meant === undefined ? undefined : forms().get(side);
      if (w?.quoted === true && meant !== undefined) {
        return `${w.text} in double quotes is a field named "${name}", not a string; write '${name}' for the string, or \`${name}\` for ${meant}`;
      }
      if (BARE_LITERALS.has(name)) {
        return `${name} here is a field named "${name}", not the literal; write \`${name}\``;
      }
      return undefined;
    }
    if (
      ORDERING.has(String(cmp.name)) &&
      side.type === 'Literal' &&
      typeof side.value === 'string' &&
      NUMERIC.test(side.value)
    ) {
      const text = forms().get(side)?.text ?? `'${side.value}'`;
      return `${text} is a string and JMESPath orders only numbers; write \`${side.value}\``;
    }
    return undefined;
  };
  const out: string[] = [];
  const visit = (node: JmesNode): void => {
    const sides = childrenOf(node);
    const [left, right] = sides;
    if (
      node.type === 'Comparator' &&
      COMPARATORS[String(node.name)] !== undefined &&
      left !== undefined &&
      right !== undefined
    ) {
      for (const side of [left, right]) {
        const message = suspect(node, side);
        if (message !== undefined) {
          out.push(`${render(node, forms())}: ${message}`);
        }
      }
    }
    sides.forEach(visit);
  };
  visit(p.ast);
  return out.map((m) => unplace(m, placeholders));
}

/** Replaces each placeholder in `text` with the template it stands for. */
export function unplace(text: string, placeholders: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [placeholder, template] of placeholders) {
    out = out.replaceAll(placeholder, template);
  }
  return out;
}

/**
 * Parses once to fail fast on syntax errors. Evaluation re-parses via `search` because the
 * `jmespath` package exposes no interpreter over a pre-built AST; expressions are short.
 */
export function compileFilter(expr: string): Filter {
  const p = parseJmespath(expr);
  if (!p.ok) {
    throw new FilterSyntaxError(expr, p.message);
  }
  return {
    expr,
    evaluate: (data) => isJmesTruthy(search(data, expr)),
  };
}
