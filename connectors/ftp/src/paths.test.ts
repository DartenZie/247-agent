import { describe, expect, it } from 'vitest';

import { childPath, normalizeRoot, parentPath, resolveRemote } from './paths.js';

describe('resolveRemote', () => {
  it('joins a relative path with the root', () => {
    expect(resolveRemote('/srv/x', 'a/b.txt')).toEqual({
      rel: 'a/b.txt',
      remote: '/srv/x/a/b.txt',
    });
    expect(resolveRemote('.', 'a/b.txt')).toEqual({ rel: 'a/b.txt', remote: 'a/b.txt' });
    expect(resolveRemote('/', 'a')).toEqual({ rel: 'a', remote: '/a' });
    expect(resolveRemote('up', 'a')).toEqual({ rel: 'a', remote: 'up/a' });
  });

  it('normalises without leaving the root', () => {
    expect(resolveRemote('/srv/x', './a').rel).toBe('a');
    expect(resolveRemote('/srv/x', 'a/../b').rel).toBe('b');
    expect(resolveRemote('/srv/x', 'a//b/').rel).toBe('a/b');
    expect(resolveRemote('/srv/x', 'a/./b').rel).toBe('a/b');
    expect(resolveRemote('/srv/x', 'a/b/../..').rel).toBe('.');
  });

  it('treats an empty path and "." as the root', () => {
    expect(resolveRemote('/srv/x', '')).toEqual({ rel: '.', remote: '/srv/x' });
    expect(resolveRemote('/srv/x', '.')).toEqual({ rel: '.', remote: '/srv/x' });
    expect(resolveRemote('.', '.')).toEqual({ rel: '.', remote: '.' });
  });

  it('rejects escapes, absolute paths and odd bytes', () => {
    for (const bad of ['..', '../x', 'a/../../x', 'a/../..', '/etc/passwd', '/', 'a\0b', 'a\\b']) {
      expect(() => resolveRemote('/srv/x', bad), bad).toThrow(/invalid path/);
    }
    expect(() => resolveRemote('/srv/x', '../x')).toThrow(/escapes the root/);
    expect(() => resolveRemote('/srv/x', '/x')).toThrow(/absolute/);
  });
});

describe('helpers', () => {
  it('normalizeRoot strips a trailing slash but keeps "/"', () => {
    expect(normalizeRoot('/srv/x/')).toBe('/srv/x');
    expect(normalizeRoot('/')).toBe('/');
    expect(normalizeRoot('')).toBe('.');
    expect(normalizeRoot('./up/')).toBe('up');
  });

  it('childPath and parentPath', () => {
    expect(childPath('.', 'f')).toBe('f');
    expect(childPath('a/b', 'f')).toBe('a/b/f');
    expect(parentPath('.')).toBeNull();
    expect(parentPath('f')).toBe('.');
    expect(parentPath('a/b/f')).toBe('a/b');
  });
});
