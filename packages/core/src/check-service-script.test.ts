import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/check-service.sh', import.meta.url));

let root: string;
let bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oa-check-service-'));
  bin = join(root, 'bin');
  mkdirSync(bin);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `oa health` output as the CLI prints it (packages/cli/src/commands/health.ts). */
function report(status: string, dispatcher = 'ok', database = 'ok', connectors = 'ok'): string {
  return [
    `${status}\tpid=1\tuptime=5s\ttasks=1\truns=0 pending, 0 in flight`,
    `dispatcher\t${dispatcher}`,
    `database\t${database}`,
    `connectors\t${connectors}\tup=0/1 down=email`,
  ].join('\n');
}

interface Fakes {
  /** What `systemctl is-active` reports. */
  active?: string;
  /** NRestarts, one value per `systemctl show` call (the last one repeats). */
  restarts?: string[];
  /** What `oa health` prints, or null for a daemon that cannot be reached. */
  health?: string | null;
}

/** A fake `systemctl` and `oa` on PATH, scripted by files under the temp dir. */
function fakes({ active = 'active', restarts = ['0'], health = report('ok') }: Fakes): string {
  writeFileSync(join(root, 'active'), active);
  writeFileSync(join(root, 'restarts'), restarts.join('\n') + '\n');
  writeFileSync(join(root, 'calls'), '0');
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/sh
d=${JSON.stringify(root)}
case "$1" in
  is-active)
    state=$(cat "$d/active")
    case "$*" in *--quiet*) ;; *) echo "$state" ;; esac
    [ "$state" = active ] ;;
  show)
    n=$(($(cat "$d/calls") + 1)); echo $n > "$d/calls"
    line=$(sed -n "\${n}p" "$d/restarts"); [ -n "$line" ] || line=$(tail -n 1 "$d/restarts")
    echo "$line" ;;
  *) echo "unexpected systemctl $*" >&2; exit 9 ;;
esac
`,
  );
  const oa = join(bin, 'oa');
  writeFileSync(join(root, 'health'), health ?? '');
  writeFileSync(
    oa,
    `#!/bin/sh
printf '%s\\n' "$*" > ${JSON.stringify(join(root, 'oa-args'))}
[ "$1" = health ] || exit 9
${
  health === null
    ? 'echo "oa: cannot reach the daemon at /run/247-agent/core.sock" >&2; exit 1'
    : `cat ${JSON.stringify(join(root, 'health'))}; echo
case $(head -n 1 ${JSON.stringify(join(root, 'health'))}) in ok*) exit 0 ;; *) exit 1 ;; esac`
}
`,
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(oa, 0o755);
  return oa;
}

function check(oa: string, extra: string[] = []) {
  return spawnSync(
    'sh',
    [
      script,
      '--oa',
      oa,
      '--settle',
      '0',
      '--tries',
      '2',
      '--config',
      join(root, 'none.yaml'),
      ...extra,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } },
  );
}

describe.skipIf(process.platform === 'win32')('check-service.sh', () => {
  it('passes when the unit stays active and the daemon answers ok', () => {
    const run = check(fakes({}));
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('247-agent is up: ok');
  });

  it('fails when the unit is not active after the settle delay', () => {
    const run = check(fakes({ active: 'activating' }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('247-agent is not up: the unit is activating');
    expect(run.stderr).toContain('journalctl -u 247-agent');
  });

  it('fails when systemd restarted the daemon while it settled', () => {
    const run = check(fakes({ restarts: ['0', '2'] }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('247-agent is not up: systemd restarted it 2 times');
  });

  it('reads the restart count before and after the settle delay', () => {
    check(fakes({}));
    expect(readFileSync(join(root, 'calls'), 'utf8').trim()).toBe('2');
  });

  it('fails when the daemon cannot be reached', () => {
    const run = check(fakes({ health: null }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('247-agent is not up: oa health did not answer');
    expect(run.stderr).toContain('cannot reach the daemon');
  });

  it('fails when the dispatcher or the database is failing', () => {
    for (const health of [
      report('failing', 'failing since=x'),
      report('failing', 'ok', 'failing'),
    ]) {
      const run = check(fakes({ health }));
      expect(run.status, health).toBe(1);
      expect(run.stderr).toContain('247-agent is not up: oa health reports failing');
    }
  });

  it('passes with a warning when only the connectors are failing', () => {
    const run = check(fakes({ health: report('failing', 'ok', 'ok', 'failing') }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('247-agent is up: failing');
    expect(run.stderr).toContain('warning: no connector is up');
  });

  it('passes with a warning when the daemon is degraded', () => {
    const run = check(fakes({ health: report('degraded', 'ok', 'ok', 'degraded') }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('247-agent is up: degraded');
    expect(run.stderr).toContain('warning: 247-agent is degraded');
  });

  it('asks the socket that agent.yaml names, relative to the file', () => {
    const config = join(root, 'etc', 'agent.yaml');
    mkdirSync(join(root, 'etc'));
    writeFileSync(config, "db: state.db\nsocket: 'run/core.sock' # comment\nlog:\n  level: info\n");
    const run = check(fakes({}), ['--config', config]);
    expect(run.status).toBe(0);
    expect(readFileSync(join(root, 'oa-args'), 'utf8').trim()).toBe(
      `health --socket ${join(root, 'etc', 'run', 'core.sock')}`,
    );
  });

  it('asks the default socket when agent.yaml names none', () => {
    const run = check(fakes({}));
    expect(run.status).toBe(0);
    expect(readFileSync(join(root, 'oa-args'), 'utf8').trim()).toBe('health');
  });
});
