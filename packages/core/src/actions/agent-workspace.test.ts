import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkspace } from './agent-workspace.js';

describe('createWorkspace', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oa-ws-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('puts the workspace under the real path of a symlinked work_dir', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'link');
    symlinkSync(real, link);
    const ws = await createWorkspace({ kind: 'temp' }, link, 'run_01TEST');
    expect(ws.path).toBe(join(realpathSync(real), 'run_01TEST'));
    expect(existsSync(ws.path)).toBe(true);
    await ws.remove();
    expect(existsSync(ws.path)).toBe(false);
  });
});
