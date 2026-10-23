import { execa } from 'execa';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const MODULE = new URL('./process-group.ts', import.meta.url).pathname;

/** Alive and not a zombie: an orphan stays one where nothing reaps it (a container's `sleep` PID 1). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') {
    return true;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * A daemon stand-in: starts `sleep` in a group of its own, registers it, handles the first
 * SIGTERM as `main.ts` does (a stop that never finishes), prints the pid and then `then`s.
 */
function daemon(then: string) {
  const script = [
    "import { spawn } from 'node:child_process';",
    `import { killGroupOnExit } from ${JSON.stringify(MODULE)};`,
    "const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });",
    'killGroupOnExit(child.pid);',
    'process.once("SIGTERM", () => undefined);',
    'setInterval(() => undefined, 60000);',
    "process.stdout.write(child.pid + '\\n');",
    then,
  ].join('\n');
  return execa('node', ['--input-type=module', '-e', script], { reject: false });
}

async function groupPid(d: { stdout: NodeJS.ReadableStream }): Promise<number> {
  return new Promise((resolve) => {
    d.stdout.once('data', (chunk: Buffer) => {
      resolve(Number(chunk.toString().trim()));
    });
  });
}

describe('killGroupOnExit', () => {
  it('kills the group when the daemon exits without stopping it', async () => {
    const d = daemon('setTimeout(() => process.exit(1), 50);');
    const pid = await groupPid(d);
    await d;
    try {
      await until(() => !alive(pid));
    } finally {
      if (alive(pid)) {
        process.kill(-pid, 'SIGKILL');
      }
    }
  });

  it('kills the group when a second SIGTERM ends the daemon', async () => {
    const d = daemon('');
    const pid = await groupPid(d);
    d.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    d.kill('SIGTERM');
    const r = await d;
    try {
      expect(r.signal).toBe('SIGTERM');
      await until(() => !alive(pid));
    } finally {
      if (alive(pid)) {
        process.kill(-pid, 'SIGKILL');
      }
    }
  });
});
