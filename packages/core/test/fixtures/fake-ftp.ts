/**
 * A fake (S)FTP connector: the seven file ops of `connectors/ftp` over an in-memory tree
 * seeded from the manifest's `config.files` (`{ "incoming/a.csv": "text" }`). Same
 * output shapes and the same path rules as the real one; never touches the network.
 */
import { posix } from 'node:path';

import { z } from 'zod';

import { defineTool, runConnector, type JsonValue } from '../../../connector-sdk/src/index.ts';

const MTIME = '2026-06-01T08:00:00.000Z';
const encoding = z.enum(['utf8', 'base64']).optional();

function resolve(input: string | undefined): string {
  const raw = input ?? '.';
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
    throw new Error(`invalid path ${JSON.stringify(raw)}: absolute paths are not allowed`);
  }
  let rel = posix.normalize(raw === '' ? '.' : raw);
  if (rel.length > 1 && rel.endsWith('/')) {
    rel = rel.slice(0, -1);
  }
  if (rel === '..' || rel.startsWith('../')) {
    throw new Error(`invalid path ${JSON.stringify(raw)}: escapes the root`);
  }
  return rel;
}

await runConnector({
  tools: (rt) => {
    const files = new Map<string, Buffer>();
    const dirs = new Set<string>(['.']);
    const addDirs = (path: string): void => {
      let d = path;
      while (d !== '.' && !dirs.has(d)) {
        dirs.add(d);
        d = posix.dirname(d);
      }
    };
    const seed = (rt.env.config.files ?? {}) as Record<string, string>;
    for (const [p, content] of Object.entries(seed)) {
      const rel = resolve(p);
      files.set(rel, Buffer.from(content));
      addDirs(posix.dirname(rel));
    }
    const maxBytes =
      typeof rt.env.config.max_bytes === 'number' ? rt.env.config.max_bytes : 1_000_000;

    const entry = (path: string): JsonValue | null => {
      const data = files.get(path);
      if (data !== undefined) {
        return { name: posix.basename(path), path, type: 'file', size: data.length, mtime: MTIME };
      }
      if (dirs.has(path)) {
        return { name: posix.basename(path), path, type: 'dir', size: 0, mtime: null };
      }
      return null;
    };
    const children = (dir: string): string[] => {
      const prefix = dir === '.' ? '' : `${dir}/`;
      const direct = (p: string): boolean =>
        p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
      return [...files.keys(), ...dirs].filter(direct).sort();
    };
    const mkdir = (rel: string): void => {
      addDirs(rel);
    };

    return [
      defineTool({
        name: 'list',
        input: { path: z.string().optional(), limit: z.number().int().min(1).optional() },
        handler: (args) => {
          const rel = resolve(args.path);
          if (!dirs.has(rel)) {
            throw new Error(`list ${rel}: no such directory`);
          }
          const all = children(rel).map(entry);
          const limit = args.limit ?? 1000;
          rt.log(`list ${rel} -> ${String(all.length)}`);
          return { path: rel, entries: all.slice(0, limit), truncated: all.length > limit };
        },
      }),
      defineTool({
        name: 'stat',
        input: { path: z.string() },
        handler: (args) => {
          const rel = resolve(args.path);
          const e = entry(rel);
          return e === null ? { path: rel, exists: false } : { exists: true, ...(e as object) };
        },
      }),
      defineTool({
        name: 'read',
        input: { path: z.string(), encoding },
        handler: (args) => {
          const rel = resolve(args.path);
          const data = files.get(rel);
          if (data === undefined) {
            throw new Error(`${rel}: not found`);
          }
          if (data.length > maxBytes) {
            throw new Error(`${rel}: ${String(data.length)} bytes exceeds max_bytes`);
          }
          const enc = args.encoding ?? 'utf8';
          rt.log(`read ${rel} ${String(data.length)} bytes`);
          return { path: rel, content: data.toString(enc), encoding: enc, size: data.length };
        },
      }),
      defineTool({
        name: 'write',
        input: {
          path: z.string(),
          content: z.string(),
          encoding,
          parents: z.boolean().optional(),
          overwrite: z.boolean().optional(),
        },
        handler: (args) => {
          const rel = resolve(args.path);
          const data = Buffer.from(args.content, args.encoding ?? 'utf8');
          if (args.overwrite === false && entry(rel) !== null) {
            throw new Error(`${rel}: already exists and overwrite is false`);
          }
          const parent = posix.dirname(rel);
          if (args.parents ?? true) {
            mkdir(parent);
          } else if (!dirs.has(parent)) {
            throw new Error(`${rel}: no such directory ${parent}`);
          }
          files.set(rel, data);
          rt.log(`write ${rel} ${String(data.length)} bytes`);
          return { path: rel, size: data.length };
        },
      }),
      defineTool({
        name: 'delete',
        input: {
          path: z.string(),
          recursive: z.boolean().optional(),
          missing_ok: z.boolean().optional(),
        },
        handler: (args) => {
          const rel = resolve(args.path);
          if (files.delete(rel)) {
            return { path: rel, deleted: true, type: 'file' };
          }
          if (dirs.has(rel) && rel !== '.') {
            const inside = [...files.keys(), ...dirs].filter((p) => p.startsWith(`${rel}/`));
            if (inside.length > 0 && args.recursive !== true) {
              throw new Error(`${rel}: directory not empty`);
            }
            for (const p of inside) {
              files.delete(p);
              dirs.delete(p);
            }
            dirs.delete(rel);
            return { path: rel, deleted: true, type: 'dir' };
          }
          if (args.missing_ok === true) {
            return { path: rel, deleted: false, type: null };
          }
          throw new Error(`${rel}: not found`);
        },
      }),
      defineTool({
        name: 'rename',
        input: { from: z.string(), to: z.string(), parents: z.boolean().optional() },
        handler: (args) => {
          const from = resolve(args.from);
          const to = resolve(args.to);
          if (args.parents === true) {
            mkdir(posix.dirname(to));
          }
          const data = files.get(from);
          if (data === undefined) {
            throw new Error(`${from}: not found`);
          }
          if (!dirs.has(posix.dirname(to))) {
            throw new Error(`${to}: no such directory`);
          }
          files.delete(from);
          files.set(to, data);
          rt.log(`rename ${from} -> ${to}`);
          return { from, to };
        },
      }),
      defineTool({
        name: 'mkdir',
        input: { path: z.string() },
        handler: (args) => {
          const rel = resolve(args.path);
          mkdir(rel);
          return { path: rel };
        },
      }),
    ];
  },
});
