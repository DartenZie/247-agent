import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Clock } from '../clock.js';
import { TasksFile } from '../config/schema.js';
import { createLogger, type Logger } from '../log.js';
import { openStore, type Store } from '../store/store.js';
import { compileConfig, type CompiledConfig } from './matcher.js';

/** Test helpers shared by bus/scheduler/core tests. Not exported from the package. */

export interface TestEnv {
  dir: string;
  store: Store;
  clock: Clock & { set(iso: string): void };
  log: Logger;
  lines: Record<string, unknown>[];
  close(): void;
}

export function testEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'oa-test-'));
  const store = openStore(join(dir, 'state.db'));
  let now = new Date('2026-09-19T10:00:00.000Z');
  const clock = {
    now: () => now,
    set: (iso: string) => {
      now = new Date(iso);
    },
  };
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (l) => {
      lines.push(JSON.parse(l) as Record<string, unknown>);
    },
  });
  return {
    dir,
    store,
    clock,
    log,
    lines,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function config(tasks: unknown[]): CompiledConfig {
  return compileConfig(TasksFile.parse({ tasks }));
}

export const shell = { kind: 'shell', cmd: ['true'] };
