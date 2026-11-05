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

interface Fakes {
  /** What `systemctl is-active` reports. */
  active?: string;
  /** NRestarts, one value per `systemctl show` call (the last one repeats). */
  restarts?: string[];
  /** The first line `oa health` prints, or null for a daemon that cannot be reached. */
  health?: string | null;
}

/** A fake `systemctl` and `oa` on PATH, scripted by files under the temp dir. */
function fakes({
  active = 'active',
  restarts = ['0'],
  health = 'ok\tpid=1\tuptime=5s\ttasks=1\truns=0 pending, 0 in flight',
}: Fakes): string {
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
    health === null
      ? '#!/bin/sh\necho "oa: cannot reach the daemon at /run/247-agent/core.sock" >&2\nexit 1\n'
      : `#!/bin/sh
[ "$1" = health ] || exit 9
line=$(cat ${JSON.stringify(join(root, 'health'))})
printf '%s\\ndispatcher\\tok\\n' "$line"
case $line in ok*) exit 0 ;; *) exit 1 ;; esac
`,
  );
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(oa, 0o755);
  return oa;
}

function check(oa: string, extra: string[] = []) {
  return spawnSync('sh', [script, '--oa', oa, '--settle', '0', '--tries', '2', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
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

  it('fails when the daemon cannot be reached', () => {
    const run = check(fakes({ health: null }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('247-agent is not up: oa health did not answer');
    expect(run.stderr).toContain('cannot reach the daemon');
  });

  it('fails when the daemon reports failing', () => {
    const run = check(fakes({ health: 'failing\tpid=1' }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('247-agent is not up: oa health reports failing');
  });

  it('passes with a warning when the daemon is degraded', () => {
    const run = check(fakes({ health: 'degraded\tpid=1' }));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('247-agent is up: degraded');
    expect(run.stderr).toContain('warning: 247-agent is degraded');
  });

  it('reads the restart count before and after the settle delay', () => {
    check(fakes({}));
    expect(readFileSync(join(root, 'calls'), 'utf8').trim()).toBe('2');
  });
});
