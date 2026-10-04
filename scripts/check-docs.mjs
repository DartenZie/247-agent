#!/usr/bin/env node
// Checks the Markdown documentation: every relative link resolves, every `yaml` block
// parses, and every complete tasks file or connector manifest inside a `yaml` block
// passes `oa validate`. A block preceded by `<!-- check: skip -->` is left alone.
//
//   node scripts/check-docs.mjs            # every Markdown file in the repo
//   node scripts/check-docs.mjs docs/tasks # one directory or file
//
// Exit 0 when everything passes, 1 on a failure, 2 when it could not run.

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/main.js');
const skipDirs = new Set([
  'node_modules',
  'dist',
  'dist-release',
  '.git',
  '.cache',
  'local',
  '.state',
  '.claude',
]);

function markdownFiles(start) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (entry.name.endsWith('.md')) {
        out.push(join(dir, entry.name));
      }
    }
  };
  const st = statSync(start);
  if (st.isDirectory()) {
    walk(start);
  } else {
    out.push(start);
  }
  return out.sort();
}

const failures = [];
const fail = (file, line, msg) => failures.push(`${relative(root, file)}:${line}: ${msg}`);

// Links: [text](target) where target is relative. Anchors, URLs and mailto are skipped.
function checkLinks(file, text) {
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    if (inFence) {
      return;
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) {
        continue;
      }
      const path = target.replace(/[#?].*$/, '');
      if (!path) {
        continue;
      }
      if (!existsSync(resolve(dirname(file), path))) {
        fail(file, i + 1, `broken link: ${target}`);
      }
    }
  });
}

// YAML blocks: parse every one; validate those that are a tasks file or a manifest.
function checkYaml(file, text, scratch) {
  const lines = text.split('\n');
  let i = 0;
  let skipNext = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*<!--\s*check:\s*skip\s*-->\s*$/.test(line)) {
      skipNext = true;
      i++;
      continue;
    }
    const open = line.match(/^(\s*)(```+|~~~+)\s*([\w-]+)?/);
    if (!open) {
      if (line.trim() !== '') {
        skipNext = false;
      }
      i++;
      continue;
    }
    const fence = open[2];
    const lang = open[3];
    const start = i + 1;
    let j = start;
    while (j < lines.length && !lines[j].startsWith(open[1] + fence)) {
      j++;
    }
    const body = lines.slice(start, j).join('\n');
    const skip = skipNext;
    skipNext = false;
    i = j + 1;
    if (lang !== 'yaml' && lang !== 'yml') {
      continue;
    }
    if (skip) {
      continue;
    }
    let doc;
    try {
      doc = parseYaml(body);
    } catch (e) {
      fail(file, start, `yaml does not parse: ${e.message.split('\n')[0]}`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      continue;
    }
    // A tasks file has task objects under `tasks`; an agent.yaml fragment lists paths there.
    const isTasksFile =
      Array.isArray(doc.tasks) &&
      doc.tasks.length > 0 &&
      doc.tasks.every((t) => t !== null && typeof t === 'object');
    const isManifest =
      typeof doc.name === 'string' && (Array.isArray(doc.exec) || typeof doc.builtin === 'string');
    if (!isTasksFile && !isManifest) {
      continue;
    }
    const tmp = join(scratch, `block-${start}-${Math.random().toString(36).slice(2, 8)}.yaml`);
    writeFileSync(tmp, body);
    try {
      execFileSync(process.execPath, [cli, 'validate', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
        .toString()
        .trim()
        .split('\n')
        .slice(0, 6)
        .join('\n    ');
      fail(
        file,
        start,
        `oa validate rejects this ${isTasksFile ? 'tasks file' : 'manifest'}:\n    ${out}`,
      );
    }
  }
}

function main() {
  if (!existsSync(cli)) {
    console.error(`check-docs: ${relative(root, cli)} is missing; run npm run build first`);
    return 2;
  }
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2).map((p) => resolve(p))
    : [root];
  const files = targets.flatMap(markdownFiles);
  const scratch = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      checkLinks(file, text);
      checkYaml(file, text, scratch);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const f of failures) {
    console.error(f);
  }
  console.log(
    `check-docs: ${files.length} files, ${failures.length} failure${failures.length === 1 ? '' : 's'}`,
  );
  return failures.length ? 1 : 0;
}

process.exit(main());
