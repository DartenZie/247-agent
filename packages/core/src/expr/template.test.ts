import { describe, expect, it } from 'vitest';

import {
  collectTemplateRefs,
  compileTemplate,
  evaluateExpr,
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
    expect(validateTemplate('${event.type}')).toBeNull();
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

  it('does not mistake a payload field named secrets for the scope, but flags whole-object use', () => {
    const refs = collectTemplateRefs(['${event.payload.secrets.x}', '${secrets}', '${secrets.*}']);
    expect(refs.secrets).toEqual([]);
    expect(refs.wholeSecrets).toEqual(['${secrets}', '${secrets.*}']);
  });

  it('reports templates that do not compile', () => {
    const refs = collectTemplateRefs({ a: '${ event[ }', b: 'ok' });
    expect(refs.errors).toEqual([
      { template: '${ event[ }', message: expect.stringMatching(/JMESPath/) as string },
    ]);
  });
});

describe('evaluateExpr', () => {
  it('evaluates a bare expression against the scope', () => {
    expect(evaluateExpr("event.payload.from == 'a@b.cz'", scope)).toBe(true);
    expect(evaluateExpr('result.emails', scope)).toEqual(scope.result.emails);
  });
});
