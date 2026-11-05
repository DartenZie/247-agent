import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const stageShare = join(repo, 'scripts/stage-share.sh');
const checkDocs = join(repo, 'scripts/check-docs.mjs');

let stage: string;
beforeEach(() => {
  stage = mkdtempSync(join(tmpdir(), 'oa-share-'));
});
afterEach(() => {
  rmSync(stage, { recursive: true, force: true });
});

function stageTree(): void {
  const run = spawnSync('bash', [stageShare, stage], { cwd: repo, encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
}

describe.skipIf(process.platform === 'win32')('the release share/ tree', () => {
  it('ships the connector example task files under share/connectors/<name>/examples', () => {
    stageTree();
    for (const file of [
      'email/examples/auto-reply.yaml',
      'email/examples/daily-digest.yaml',
      'ftp/examples/inbox-import.yaml',
      'webhook/examples/github-deploy.yaml',
    ]) {
      expect(existsSync(join(stage, 'share/connectors', file)), file).toBe(true);
    }
  });

  it('has no broken relative link in the installed docs and skills', () => {
    stageTree();
    const run = spawnSync(
      process.execPath,
      [checkDocs, '--links-only', join(stage, 'share/doc'), join(stage, 'share/skills')],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
