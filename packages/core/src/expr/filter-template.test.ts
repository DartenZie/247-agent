import { describe, expect, it } from 'vitest';

import { renderFilter } from './filter-template.js';
import { compileFilter } from './jmespath.js';
import { TemplateRenderError } from './template.js';

/** Renders `filter` for a run whose trigger carried `trigger`, as a predicate over events. */
function armed(filter: string, trigger: unknown): (event: unknown) => boolean {
  const rendered = renderFilter(filter, { event: { payload: trigger } });
  const compiled = compileFilter(rendered);
  return (event) => compiled.evaluate(event);
}

const reply = (payload: unknown): unknown => ({ type: 'chat.reply', payload });

describe('renderFilter', () => {
  it('leaves a filter without templates alone', () => {
    expect(renderFilter("payload.ok == 'yes'", {})).toBe("payload.ok == 'yes'");
  });

  it('renders a plain value inside quotes the way it is written', () => {
    expect(
      renderFilter("payload.correlation_id == '${event.correlation_id}'", {
        event: { correlation_id: 'cor_1' },
      }),
    ).toBe("payload.correlation_id == 'cor_1'");
  });

  describe('a value inside single quotes is compared as that string', () => {
    const byName = "payload.name == '${event.payload.name}'";

    it('with an apostrophe', () => {
      const matches = armed(byName, { name: "O'Brien" });
      expect(matches(reply({ name: "O'Brien" }))).toBe(true);
      expect(matches(reply({ name: 'OBrien' }))).toBe(false);
    });

    it('with several apostrophes and backslashes', () => {
      const name = "it's 'quoted' C:\\path\\'x";
      const matches = armed(byName, { name });
      expect(matches(reply({ name }))).toBe(true);
      expect(matches(reply({ name: 'its quoted' }))).toBe(false);
    });

    it('with a crafted JMESPath fragment: no unrelated event matches', () => {
      const crafted = "x' || 'a' == 'a";
      const matches = armed(byName, { name: crafted });
      expect(matches(reply({ name: 'someone else', approved: true }))).toBe(false);
      expect(matches(reply({ name: crafted }))).toBe(true);
    });

    it('with a crafted JSON literal fragment', () => {
      const crafted = "x' || `true` || 'y";
      const byKey = armed("payload.key == '${event.payload.key}'", { key: crafted });
      expect(byKey(reply({ key: 'ZZZ-9' }))).toBe(false);
      expect(byKey(reply({ key: crafted }))).toBe(true);
    });

    it('with backticks', () => {
      const name = 'tick `here` and `there`';
      const matches = armed(byName, { name });
      expect(matches(reply({ name }))).toBe(true);
      expect(matches(reply({ name: 'tick here and there' }))).toBe(false);
    });

    it('with text around the template', () => {
      const matches = armed("payload.ref == 'ticket-${event.payload.id}'", { id: "7'" });
      expect(matches(reply({ ref: "ticket-7'" }))).toBe(true);
      expect(matches(reply({ ref: 'ticket-7' }))).toBe(false);
    });

    it('with an escaped quote already in the written text', () => {
      const matches = armed("payload.ref == 'it\\'s ${event.payload.id}'", { id: 'a' });
      expect(matches(reply({ ref: "it's a" }))).toBe(true);
    });

    it('with a missing value, as the empty string', () => {
      const matches = armed(byName, {});
      expect(matches(reply({ name: '' }))).toBe(true);
      expect(matches(reply({ name: 'x' }))).toBe(false);
    });

    it('with a non-string value, as its JSON', () => {
      const matches = armed("payload.n == '${event.payload.n}'", { n: 42 });
      expect(matches(reply({ n: '42' }))).toBe(true);
      expect(matches(reply({ n: 42 }))).toBe(false);
    });
  });

  describe('a bare template is compared as the value itself', () => {
    it('a string stays a string, not a field name', () => {
      const matches = armed('payload.name == ${event.payload.name}', { name: 'ann' });
      expect(matches(reply({ name: 'ann' }))).toBe(true);
      expect(matches(reply({ name: 'bob', ann: 'bob' }))).toBe(false);
    });

    it('a number orders as a number', () => {
      const matches = armed('payload.n > ${event.payload.min}', { min: 10 });
      expect(matches(reply({ n: 11 }))).toBe(true);
      expect(matches(reply({ n: 9 }))).toBe(false);
    });

    it('a boolean and a missing value compare as JSON', () => {
      expect(armed('payload.ok == ${event.payload.ok}', { ok: true })(reply({ ok: true }))).toBe(
        true,
      );
      const missing = armed('payload.gone == ${event.payload.gone}', {});
      expect(missing(reply({}))).toBe(true);
      expect(missing(reply({ gone: 'x' }))).toBe(false);
    });

    it('a crafted string cannot widen the filter', () => {
      const crafted = '`true` || `true`';
      const matches = armed('payload.name == ${event.payload.name}', { name: crafted });
      expect(matches(reply({ name: 'someone else' }))).toBe(false);
      expect(matches(reply({ name: crafted }))).toBe(true);
    });
  });

  describe('a template inside backticks is a JSON value', () => {
    it('a number or boolean on its own', () => {
      expect(armed('payload.n >= `${event.payload.min}`', { min: 3 })(reply({ n: 3 }))).toBe(true);
      expect(
        armed('payload.ok == `${event.payload.ok}`', { ok: false })(reply({ ok: false })),
      ).toBe(true);
    });

    it('a string on its own, with backticks in it', () => {
      const name = 'a`b';
      const matches = armed('payload.name == `${event.payload.name}`', { name });
      expect(matches(reply({ name }))).toBe(true);
      expect(matches(reply({ name: 'ab' }))).toBe(false);
    });

    it('inside a larger JSON literal, as text in a JSON string', () => {
      const matches = armed('payload.tag == `{"k": "${event.payload.k}"}`', { k: 'v"`' });
      expect(matches(reply({ tag: { k: 'v"`' } }))).toBe(true);
      expect(matches(reply({ tag: { k: 'v' } }))).toBe(false);
    });
  });

  it('a template inside double quotes names a field', () => {
    const matches = armed('"${event.payload.field}" == \'x\'', { field: 'odd"name' });
    expect(matches({ 'odd"name': 'x' })).toBe(true);
    expect(matches({ 'odd"name': 'y' })).toBe(false);
  });

  it('an expression that fails to evaluate fails the render', () => {
    expect(() =>
      renderFilter("payload.n == '${length(event.payload.n)}'", { event: { payload: { n: 1 } } }),
    ).toThrow(TemplateRenderError);
  });
});
