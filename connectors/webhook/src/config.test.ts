import { describe, expect, it } from 'vitest';

import { parseConfig, routeName, secretHeader, startupWarnings } from './config.js';

const route = { path: '/hooks/github', event: 'github', verify: { kind: 'github', secret: 's' } };

describe('parseConfig', () => {
  it('fills the defaults', () => {
    const c = parseConfig({ routes: [route] });
    expect(c.listen).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(c.max_body).toBe(1024 * 1024);
    expect(c.routes[0]).toMatchObject({ name: 'hooks-github', methods: ['POST'] });
  });

  it('lowercases header names and uppercases methods', () => {
    const c = parseConfig({
      routes: [{ ...route, type_header: 'X-GitHub-Event', methods: ['post', 'put', 'POST'] }],
    });
    expect(c.routes[0]?.type_header).toBe('x-github-event');
    expect(c.routes[0]?.methods).toEqual(['POST', 'PUT']);
  });

  it('accepts a Unix socket listener', () => {
    const c = parseConfig({ listen: { path: '/run/x/http.sock' }, routes: [route] });
    expect(c.listen).toEqual({ path: '/run/x/http.sock', mode: '0660' });
  });

  it('rejects duplicate paths, the health path, bad events and empty secrets', () => {
    expect(() => parseConfig({ routes: [route, route] })).toThrow(/routed twice/);
    expect(() => parseConfig({ routes: [{ ...route, path: '/healthz' }] })).toThrow(/health/);
    expect(() => parseConfig({ routes: [{ ...route, event: 'Github.Push' }] })).toThrow(
      /event type/,
    );
    expect(() =>
      parseConfig({ routes: [{ ...route, verify: { kind: 'github', secret: '' } }] }),
    ).toThrow(/secret is empty/);
    expect(() => parseConfig({ routes: [] })).toThrow(/at least one route/);
    expect(() => parseConfig({ routes: [{ ...route, path: 'x' }] })).toThrow(/starts with/);
  });

  it('leaves room for the type_header segment', () => {
    expect(() =>
      parseConfig({ routes: [{ ...route, event: 'a.b.c.d.e.f.g.h', type_header: 'x-t' }] }),
    ).toThrow(/one more segment/);
  });

  it('limits connections by default and checks the timestamp layout', () => {
    expect(parseConfig({ routes: [route] }).max_connections).toBe(128);
    const hmac = (timestamp: unknown) => ({
      routes: [{ ...route, verify: { kind: 'hmac', secret: 's', header: 'x-sig', timestamp } }],
    });
    expect(parseConfig(hmac({ header: 'X-Ts' })).routes[0]?.verify).toMatchObject({
      timestamp: { header: 'x-ts', signed: '{timestamp}.{body}', tolerance: 300 },
    });
    expect(() => parseConfig(hmac({ header: 'x-ts', signed: '{body}' }))).toThrow(
      /\{timestamp\} and \{body\}/,
    );
    expect(() => parseConfig(hmac({ header: 'x-ts', signed: '{timestamp}{body}{body}' }))).toThrow(
      /\{timestamp\} and \{body\}/,
    );
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig({ routes: [route], port: 80 })).toThrow(/port/);
  });
});

describe('routeName', () => {
  it('derives a name from the path', () => {
    expect(routeName('/hooks/GitHub')).toBe('hooks-github');
    expect(routeName('/')).toBe('root');
  });
});

describe('secretHeader', () => {
  it('names the header each check reads', () => {
    expect(secretHeader({ kind: 'github', secret: 's' })).toBe('x-hub-signature-256');
    expect(secretHeader({ kind: 'gitlab', token: 't' })).toBe('x-gitlab-token');
    expect(secretHeader({ kind: 'none' })).toBeUndefined();
    expect(secretHeader({ kind: 'slack', secret: 's', tolerance: 300 })).toBe('x-slack-signature');
    expect(secretHeader({ kind: 'stripe', secret: 's', tolerance: 300 })).toBe('stripe-signature');
  });
});

describe('startupWarnings', () => {
  it('warns once for each route without dedup_header, naming the route', () => {
    const c = parseConfig({
      routes: [
        { ...route, dedup_header: 'X-GitHub-Delivery' },
        { path: '/hooks/slack', event: 'slack', verify: { kind: 'slack', secret: 's' } },
        { path: '/hooks/ci', name: 'ci', event: 'ci', verify: { kind: 'gitlab', token: 't' } },
      ],
    });
    expect(startupWarnings(c)).toEqual([
      'webhook: route /hooks/slack has no dedup_header; sender retries will create duplicate events',
      'webhook: route /hooks/ci has no dedup_header; sender retries will create duplicate events',
    ]);
  });

  it('warns about verify: none, and nothing for a verified route with dedup_header', () => {
    const open = parseConfig({
      routes: [{ path: '/in', event: 'x', dedup_header: 'X-Id', verify: { kind: 'none' } }],
    });
    expect(startupWarnings(open)).toEqual([
      'webhook: route /in accepts unauthenticated requests (verify: none)',
    ]);
    expect(startupWarnings(parseConfig({ routes: [{ ...route, dedup_header: 'X-Id' }] }))).toEqual(
      [],
    );
  });

  it('gives a route with neither check both warnings, verify first', () => {
    const c = parseConfig({ routes: [{ path: '/in', event: 'x', verify: { kind: 'none' } }] });
    expect(startupWarnings(c)).toEqual([
      'webhook: route /in accepts unauthenticated requests (verify: none)',
      'webhook: route /in has no dedup_header; sender retries will create duplicate events',
    ]);
  });
});
