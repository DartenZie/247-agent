/**
 * `scripts/check-docs.mjs` from `npm test`: the shipped examples and the `yaml` blocks in
 * the Markdown stay valid, and a broken one fails the check with its file named. Needs
 * `npm run build` first (the checker runs `packages/cli/dist/main.js validate`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const checkDocs = join(repo, 'scripts/check-docs.mjs');

const GOOD_TASKS = `tasks:
  - name: hello
    trigger: { kind: manual }
    action: { kind: shell, cmd: ["true"] }
`;
const BAD_TASKS = `tasks:
  - name: hello
    trigger: { kind: manual }
    action: { kind: nope }
`;

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [checkDocs, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oa-docs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('check-docs', () => {
  it('passes on the repository: every example file and every yaml block in the Markdown', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    // docs/examples/** (hello-world/ and connectors.d/ included) and connectors/*/examples/*.
    expect(r.stdout).toMatch(/check-docs: \d+ Markdown files, (\d+) example files, 0 failures/);
    const examples = Number(/(\d+) example files/.exec(r.stdout)?.[1]);
    expect(examples).toBeGreaterThanOrEqual(19);
  }, 120_000);

  it('validates every yaml file under an examples/ directory and names a broken one', () => {
    mkdirSync(join(dir, 'docs/examples/hello-world'), { recursive: true });
    mkdirSync(join(dir, 'connectors/demo/examples'), { recursive: true });
    mkdirSync(join(dir, 'connectors/demo/src'), { recursive: true });
    writeFileSync(join(dir, 'docs/examples/hello-world/hello-world.yaml'), BAD_TASKS);
    writeFileSync(join(dir, 'connectors/demo/examples/demo.yaml'), BAD_TASKS);
    writeFileSync(join(dir, 'docs/examples/good.yaml'), GOOD_TASKS);
    writeFileSync(join(dir, 'connectors/demo/src/not-an-example.yaml'), BAD_TASKS);

    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docs\/examples\/hello-world\/hello-world\.yaml: oa validate rejects/);
    expect(r.stderr).toMatch(/connectors\/demo\/examples\/demo\.yaml: oa validate rejects/);
    expect(r.stderr).not.toMatch(/good\.yaml|not-an-example/);
    expect(r.stdout).toMatch(/0 Markdown files, 3 example files, 2 failures/);
  }, 60_000);

  it('validates a yaml file named on the command line', () => {
    const file = join(dir, 'broken.yaml');
    writeFileSync(file, BAD_TASKS);
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/broken\.yaml: oa validate rejects/);
  }, 60_000);

  it('names the file and line of a yaml block that fails, and leaves a marked placeholder alone', () => {
    const md = join(dir, 'page.md');
    writeFileSync(
      md,
      [
        '# Page',
        '',
        '```yaml',
        BAD_TASKS,
        '```',
        '',
        '<!-- check: skip -->',
        '```yaml',
        'tasks: [ { action: ${not: yaml',
        '```',
        '',
      ].join('\n'),
    );
    const r = run(md);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/page\.md:3: oa validate rejects this tasks file/);
    // The error points at the line in the Markdown file, not at a scratch copy.
    expect(r.stderr).toMatch(/page\.md:7: tasks\[0\]\.action\.kind/);
    expect(r.stderr).not.toMatch(/block-\d+-/);
    expect(r.stdout).toMatch(/1 Markdown files, 0 example files, 1 failure$/m);
  }, 60_000);
});
