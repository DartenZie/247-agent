#!/usr/bin/env node
// Checks the Markdown documentation: every relative link resolves, every `yaml` block
// parses, and every complete tasks file or connector manifest inside a `yaml` block
// passes `oa validate`. A block preceded by `<!-- check: skip -->` is left alone. Every
// `.yaml`/`.yml` file below a directory named `examples` (docs/examples/**,
// connectors/*/examples/*) must pass `oa validate` too. `npm test` runs it
// (packages/core/src/check-docs.test.ts).
//
//   node scripts/check-docs.mjs            # every Markdown and example file in the repo
//   node scripts/check-docs.mjs docs/tasks # one directory or file (a .yaml file is an example)
//   node scripts/check-docs.mjs --links-only <stage>/share/doc   # links only, no build needed
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

const isYamlFile = (name) => /\.ya?ml$/.test(name);

// Markdown files, and example files: every `.yaml`/`.yml` file below a directory named
// `examples` (docs/examples/**, connectors/*/examples/*). A file named directly is a
// Markdown file unless its name ends in `.yaml`/`.yml`, then it is an example file.
function collect(start, out) {
  const walk = (dir, inExamples) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(path, inExamples || entry.name === 'examples');
        }
      } else if (entry.name.endsWith('.md')) {
        out.markdown.push(path);
      } else if (inExamples && isYamlFile(entry.name)) {
        out.examples.push(path);
      }
    }
  };
  if (statSync(start).isDirectory()) {
    walk(start, false);
  } else if (isYamlFile(start)) {
    out.examples.push(start);
  } else {
    out.markdown.push(start);
  }
}

const failures = [];
const show = (file) => {
  const rel = relative(root, file);
  return rel.startsWith('..') ? file : rel;
};
const fail = (file, line, msg) =>
  failures.push(`${show(file)}${line === undefined ? '' : `:${line}`}: ${msg}`);

// `oa validate` on one file; the first lines of its output on a failure, else null.
function validate(path) {
  try {
    execFileSync(process.execPath, [cli, 'validate', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.toString().trim().split('\n').slice(0, 6);
  }
}

// Example files: each must pass `oa validate` (an agent.yaml also validates the tasks
// files and manifests it points at).
function checkExample(file) {
  const out = validate(file);
  if (out) {
    fail(file, undefined, `oa validate rejects this example:\n    ${out.join('\n    ')}`);
  }
}

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
    const out = validate(tmp);
    if (out) {
      // Point `<scratch file>:<n>` at the line in the Markdown file instead.
      const where = out.map((l) =>
        l
          .split(tmp)
          .map((part, k) =>
            k === 0 ? part : part.replace(/^:(\d+)/, (_, n) => `:${start + Number(n)}`),
          )
          .join(show(file)),
      );
      fail(
        file,
        start,
        `oa validate rejects this ${isTasksFile ? 'tasks file' : 'manifest'}:\n    ${where.join('\n    ')}`,
      );
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const linksOnly = args.includes('--links-only');
  if (!linksOnly && !existsSync(cli)) {
    console.error(`check-docs: ${relative(root, cli)} is missing; run npm run build first`);
    return 2;
  }
  const paths = args.filter((a) => a !== '--links-only');
  const targets = paths.length ? paths.map((p) => resolve(p)) : [root];
  const found = { markdown: [], examples: [] };
  for (const target of targets) {
    collect(target, found);
  }
  const markdown = [...new Set(found.markdown)].sort();
  const examples = linksOnly ? [] : [...new Set(found.examples)].sort();
  const scratch = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    for (const file of markdown) {
      const text = readFileSync(file, 'utf8');
      checkLinks(file, text);
      if (!linksOnly) {
        checkYaml(file, text, scratch);
      }
    }
    for (const file of examples) {
      checkExample(file);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const f of failures) {
    console.error(f);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  console.log(
    `check-docs: ${markdown.length} Markdown files, ${examples.length} example files, ${plural(failures.length, 'failure')}`,
  );
  return failures.length ? 1 : 0;
}

process.exit(main());
