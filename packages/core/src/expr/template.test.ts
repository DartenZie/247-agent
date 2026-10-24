import { describe, expect, it } from 'vitest';

import {
  collectTemplateRefs,
  compileTemplate,
  escapedExprs,
  evaluateExpr,
  expressionRoots,
  forEachTemplate,
  parseTemplate,
  renderTemplate,
  renderText,
  renderValue,
  TemplateRenderError,
  TemplateSyntaxError,
  validateTemplate,
} from './template.js';

const scope = {
  event: { type: 'email.received', payload: { from: 'a@b.cz', n: 3, tags: ['x', 'y'] } },
  result: { last_uid: 42, emails: [{ id: 'm1' }, { id: 'm2' }] },
  state: { email: { last_uid: 41 } },
  secrets: { ftp_pass: 'hunter2' },
  env: { HOME: '/home/oa' },
};

describe('parseTemplate', () => {
  it('splits text and ${…} parts, keeping braces inside literals', () => {
    expect(parseTemplate('a ${x} b ${y.z} c')).toEqual([
      { text: 'a ' },
      { expr: 'x' },
      { text: ' b ' },
      { expr: 'y.z' },
      { text: ' c' },
    ]);
    expect(parseTemplate("${ payload.{a: b, c: 'd}'} }")).toEqual([
      { expr: "payload.{a: b, c: 'd}'}" },
    ]);
    expect(parseTemplate('${ x == `{"k": 1}` }')).toEqual([{ expr: 'x == `{"k": 1}`' }]);
    expect(parseTemplate('plain')).toEqual([{ text: 'plain' }]);
    expect(parseTemplate('')).toEqual([{ text: '' }]);
  });

  it('rejects unterminated and empty templates', () => {
    expect(() => parseTemplate('a ${x')).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate('${}')).toThrow(/empty/);
    expect(validateTemplate('${ event[ }')).toMatch(/invalid JMESPath/);
    expect(validateTemplate('n=${ event.payload.n > 2.5 }')).toMatch(/as in `2\.5`$/);
    expect(validateTemplate('${event.type}')).toBeNull();
  });
});

describe('the $${ escape', () => {
  it('yields a literal ${ that is never parsed', () => {
    expect(parseTemplate('since=$${1:-0}; n=$${#TOKEN}')).toEqual([
      { text: 'since=${1:-0}; n=${#TOKEN}' },
    ]);
    expect(parseTemplate('$${HOME} ${run.id} $${x')).toEqual([
      { text: '${HOME} ' },
      { expr: 'run.id' },
      { text: ' ${x' },
    ]);
    expect(parseTemplate('${run.id}$${x}')).toEqual([{ expr: 'run.id' }, { text: '${x}' }]);
    expect(validateTemplate('echo "$${1:-0}" $$ $1')).toBeNull();
  });

  it("leaves later templates live, and ${'$'} writes a $ before a value", () => {
    expect(renderTemplate('$${a:-${event.payload.n}}', scope)).toBe('${a:-3}');
    expect(renderTemplate("cost ${'$'}${event.payload.n}", scope)).toBe('cost $3');
    expect(renderTemplate("pid ${'$$'}${event.payload.n}", scope)).toBe('pid $$3');
    expect(escapedExprs('$${event.x} $${1:-0} $${y')).toEqual(['event.x']);
  });

  it('renders to text, so an escaped whole string is not a template', () => {
    const t = compileTemplate('$${event.type}');
    expect(t.whole).toBe(false);
    expect(t.roots.size).toBe(0);
    expect(renderTemplate('$${event.type}', scope)).toBe('${event.type}');
    expect(renderTemplate('[$${n}] ${event.payload.n}', scope)).toBe('[${n}] 3');
    expect(renderValue({ cmd: ['bash', '-c', 'echo $${1:-0}'] }, scope)).toEqual({
      cmd: ['bash', '-c', 'echo ${1:-0}'],
    });
  });

  it('is named in the error when the ${…} reads as shell', () => {
    const hint = /; a literal \$\{ is written \$\$\{$/;
    expect(validateTemplate('since=${1:-0}')).toMatch(hint);
    expect(validateTemplate('since=${1:-0}')).not.toMatch(/number literal/);
    expect(validateTemplate('${#TOKEN}')).toMatch(hint);
    expect(validateTemplate('${VAR:-x}')).toMatch(hint);
    expect(validateTemplate('${f%%.*}')).toMatch(hint);
    expect(validateTemplate('${arr[@]}')).toMatch(hint);
    expect(validateTemplate('echo ${x')).toMatch(hint);
    expect(validateTemplate('${1-0}')).toMatch(hint);
    expect(validateTemplate('${1-0}')).not.toMatch(/number literal/);
    expect(validateTemplate('${VAR=x}')).toMatch(hint);
    expect(validateTemplate('${VAR:2}')).toMatch(hint);
    expect(validateTemplate('${VAR,,}')).toMatch(hint);
    expect(validateTemplate('${a, b}')).not.toMatch(hint);
    expect(validateTemplate('${foo:bar}')).not.toMatch(hint);
    expect(validateTemplate('${ event[ }')).not.toMatch(hint);
    expect(validateTemplate('n=${ event.payload.n > 2.5 }')).not.toMatch(hint);
  });
});

describe('renderTemplate', () => {
  it('returns the raw value for a whole-string template', () => {
    expect(renderTemplate('${event.payload}', scope)).toEqual(scope.event.payload);
    expect(renderTemplate('${result.last_uid}', scope)).toBe(42);
    expect(renderTemplate('${event.payload.missing}', scope)).toBeNull();
    expect(renderTemplate('${ state.email.last_uid }', scope)).toBe(41);
  });

  it('stringifies inside a mixed string, null as empty', () => {
    expect(renderTemplate('uid=${result.last_uid}!', scope)).toBe('uid=42!');
    expect(renderTemplate('tags=${event.payload.tags}', scope)).toBe('tags=["x","y"]');
    expect(renderTemplate('from ${event.payload.from} (${event.payload.nope})', scope)).toBe(
      'from a@b.cz ()',
    );
    expect(renderText('${result.emails}', scope)).toBe('[{"id":"m1"},{"id":"m2"}]');
    expect(renderText('${event.payload.n}', scope)).toBe('3');
    expect(renderText('no template', scope)).toBe('no template');
  });

  it('leaves non-template strings alone', () => {
    expect(renderTemplate('nothing here', scope)).toBe('nothing here');
    expect(renderTemplate('$notatemplate', scope)).toBe('$notatemplate');
  });

  it('wraps runtime errors', () => {
    expect(() => renderTemplate('${ length(event.payload.n) }', scope)).toThrow(
      TemplateRenderError,
    );
  });

  it('caches compiled templates', () => {
    const t = compileTemplate('x ${event.type}');
    expect(t.whole).toBe(false);
    expect(t.render(scope)).toBe('x email.received');
  });
});

describe('renderValue', () => {
  it('renders every string in nested values, never keys', () => {
    expect(
      renderValue(
        {
          'k.${x}': ['${result.last_uid}', 'n=${event.payload.n}', 7, null, true],
          nested: { stdin: '${event.payload}' },
        },
        scope,
      ),
    ).toEqual({
      'k.${x}': [42, 'n=3', 7, null, true],
      nested: { stdin: scope.event.payload },
    });
  });
});

describe('collectTemplateRefs', () => {
  it('finds root names and secret references across a value', () => {
    const refs = collectTemplateRefs({
      cmd: ['lftp', 'sftp://${secrets.ftp_user}@host', "${ event.payload.from == 'x' }"],
      env: { P: '${secrets.ftp_pass}', Q: '${secrets.ftp_pass}' },
      when: '${ length(result.emails) > `0` && state.email.last_uid }',
      each: '${ result.emails[?id == `"m1"`] | [0] }',
      fn: '${ join(`,`, [event.type, env.HOME]) }',
      hash: '${ {a: event.type, b: run.id} }',
    });
    expect([...refs.roots].sort()).toEqual(['env', 'event', 'result', 'run', 'secrets', 'state']);
    expect(refs.secrets).toEqual(['ftp_user', 'ftp_pass']);
    expect(refs.wholeSecrets).toEqual([]);
    expect(refs.errors).toEqual([]);
  });

  it('leaves expression references out of the scope roots, but not out of secrets', () => {
    // Secrets stay collected inside `&expr`: `map(&secrets.k, [@])` reads the scope.
    const refs = collectTemplateRefs('${ map(&secrets.k, [@]) }');
    expect(refs.secrets).toEqual(['k']);
    expect([...expressionRoots('max_by(result.list, &secrets.n) && item')].sort()).toEqual([
      'item',
      'result',
    ]);
    expect([...expressionRoots('a ==')]).toEqual([]);
  });

  it('does not mistake a payload field named secrets for the scope, but flags whole-object use', () => {
    const refs = collectTemplateRefs(['${event.payload.secrets.x}', '${secrets}', '${secrets.*}']);
    expect(refs.secrets).toEqual([]);
    expect(refs.wholeSecrets).toEqual(['${secrets}', '${secrets.*}']);
  });

  it('reads through a leading @, which is the scope, and flags other uses of the scope', () => {
    const refs = collectTemplateRefs(['${@.secrets.token}', '${@.event.id}']);
    expect([...refs.roots].sort()).toEqual(['event', 'secrets']);
    expect(refs.secrets).toEqual(['token']);
    expect(refs.wholeScope).toEqual([]);
    const opaque = collectTemplateRefs(['${[@][0].secrets.token}', '${@}', '${length(@)}']);
    expect(opaque.wholeScope).toEqual(['${[@][0].secrets.token}', '${@}', '${length(@)}']);
    const projected = collectTemplateRefs(['${*.token | [0]}', '${[*]}', '${map(&@, *)}']);
    expect(projected.wholeScope).toEqual(['${*.token | [0]}', '${[*]}', '${map(&@, *)}']);
    expect(collectTemplateRefs('${event.payload.xs[*].id}').wholeScope).toEqual([]);
    // `@` inside a filter or `&expr` is the element, not the scope.
    expect(collectTemplateRefs('${event.payload.xs[?@ > `1`]}').wholeScope).toEqual([]);
    expect(collectTemplateRefs('${sort_by(event.payload.xs, &@)}').wholeScope).toEqual([]);
  });

  it('reports templates that do not compile', () => {
    const refs = collectTemplateRefs({ a: '${ event[ }', b: 'ok' });
    expect(refs.errors).toEqual([
      { template: '${ event[ }', message: expect.stringMatching(/JMESPath/) as string },
    ]);
  });
});

describe('forEachTemplate', () => {
  it('visits every template string with its path, and nothing else', () => {
    const seen: [string, readonly (string | number)[]][] = [];
    forEachTemplate(
      { cmd: ['echo', '${event.type}'], env: { A: 'x${run.id}' }, n: 3, s: 'plain', z: null },
      (text, path) => seen.push([text, path]),
    );
    expect(seen).toEqual([
      ['${event.type}', ['cmd', 1]],
      ['x${run.id}', ['env', 'A']],
    ]);
  });
});

describe('evaluateExpr', () => {
  it('evaluates a bare expression against the scope', () => {
    expect(evaluateExpr("event.payload.from == 'a@b.cz'", scope)).toBe(true);
    expect(evaluateExpr('result.emails', scope)).toEqual(scope.result.emails);
  });
});
