import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

/** The `Key=value` lines of one `[Section]` of a unit file, comments dropped. */
function section(unit: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1] ?? '';
      continue;
    }
    if (current !== name) {
      continue;
    }
    const eq = line.indexOf('=');
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

/** systemd time span in seconds; this unit uses plain seconds or `<n>min`. */
function seconds(value: string | undefined): number {
  const m = /^(\d+)(s|min)?$/.exec(value ?? '');
  if (!m) {
    throw new Error(`unsupported time span: ${String(value)}`);
  }
  return Number(m[1]) * (m[2] === 'min' ? 60 : 1);
}

describe('packaging/247-agent.service', () => {
  const unit = repo('packaging/247-agent.service');

  it('restarts after one crash but enters failed after a bounded crash loop (#108)', () => {
    const service = section(unit, 'Service');
    const meta = section(unit, 'Unit');
    expect(service.get('Restart')).toBe('always');
    // StartLimitIntervalSec= and StartLimitBurst= are [Unit] settings.
    const interval = meta.get('StartLimitIntervalSec');
    const burst = meta.get('StartLimitBurst');
    expect(interval).toBeDefined();
    expect(burst).toBeDefined();
    const restartSec = seconds(service.get('RestartSec'));
    // More than one start allowed: a single crash still restarts.
    expect(Number(burst)).toBeGreaterThan(1);
    // A loop restarting every RestartSec reaches the burst inside the interval. systemd's
    // default (5 starts in 10 s) never does with RestartSec=5, which is the bug.
    expect(Number(burst) * restartSec).toBeLessThan(seconds(interval));
  });

  it('matches the unit shown in docs/operations/production.md', () => {
    const doc = repo('docs/operations/production.md');
    const block = /## The unit\n[\s\S]*?```ini\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
    expect(block).toContain('[Service]');
    for (const name of ['Unit', 'Service', 'Install']) {
      const shipped = section(unit, name);
      shipped.delete('Documentation');
      expect(section(block, name), name).toEqual(shipped);
    }
  });
});

describe('the scripts that restart the unit', () => {
  // A unit that hit its start limit refuses `systemctl start` and `restart` until the
  // interval passes; an install or an upgrade is an explicit start and must not be refused.
  it.each(['packaging/scripts/postinstall.sh', 'scripts/install.sh'])(
    '%s clears the start limit before it starts the unit',
    (path) => {
      const lines = repo(path).split('\n');
      const starts = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /systemctl (restart|enable --now) 247-agent\b/.test(line))
        .filter(({ line }) => !line.trim().startsWith('#') && !/\b(say|echo|printf)\b/.test(line));
      expect(starts.length).toBeGreaterThan(0);
      for (const { i } of starts) {
        const before = lines.slice(Math.max(0, i - 3), i).join('\n');
        expect(before, lines[i]).toMatch(/systemctl reset-failed 247-agent/);
      }
    },
  );
});
