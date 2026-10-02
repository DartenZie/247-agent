/**
 * A stand-in for bubblewrap in tests (`test/fixtures/bin/bwrap` execs it): it reads the
 * argv `buildSandboxArgv` produces, honours what can be honoured without namespaces
 * (`--clearenv`, `--setenv`, `--chdir`) and skips the mounts, records the whole argv as
 * JSON in `$FAKE_BWRAP_LOG` when set, then runs the command after `--` with inherited
 * stdio, forwarding SIGTERM/SIGINT and its exit status. A bind to another path (the
 * network proxy socket, `/dev/null` over a protected file) cannot be mounted, so the
 * command is given the source wherever it names the destination. No isolation happens: it proves the daemon
 * builds and applies the right argv, not that bwrap works.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** bwrap options with their arity (arguments after the flag). */
const ARITY: Record<string, number> = {
  '--unshare-pid': 0,
  '--unshare-ipc': 0,
  '--unshare-net': 0,
  '--die-with-parent': 0,
  '--new-session': 0,
  '--clearenv': 0,
  '--ro-bind': 2,
  '--bind': 2,
  '--symlink': 2,
  '--setenv': 2,
  '--proc': 1,
  '--dev': 1,
  '--tmpfs': 1,
  '--chdir': 1,
};

const argv = process.argv.slice(2);
let env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
let cwd: string | undefined;
/** Destination → source of the binds that move a path. */
const moved = new Map<string, string>();
let i = 0;
while (i < argv.length && argv[i] !== '--') {
  const flag = argv[i] ?? '';
  const arity = ARITY[flag];
  if (arity === undefined) {
    process.stderr.write(`fake-bwrap: unknown option ${flag}\n`);
    process.exit(64);
  }
  const args = argv.slice(i + 1, i + 1 + arity);
  switch (flag) {
    case '--clearenv':
      env = {};
      break;
    case '--setenv':
      env[args[0] ?? ''] = args[1] ?? '';
      break;
    case '--chdir':
      cwd = args[0];
      break;
    case '--ro-bind':
    case '--bind':
      if (args[0] !== args[1]) {
        moved.set(args[1] ?? '', args[0] ?? '');
      }
      break;
    default:
      break;
  }
  i += 1 + arity;
}
const command = argv.slice(i + 1).map((a) => moved.get(a) ?? a);
if (argv[i] !== '--' || command.length === 0) {
  process.stderr.write('fake-bwrap: no command after --\n');
  process.exit(64);
}
const logFile = process.env.FAKE_BWRAP_LOG;
if (logFile !== undefined && logFile !== '') {
  appendFileSync(logFile, JSON.stringify(argv) + '\n');
}
const [file, ...rest] = command as [string, ...string[]];
const child = spawn(file, rest, { env, ...(cwd === undefined ? {} : { cwd }), stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
child.on('error', (err) => {
  process.stderr.write(`fake-bwrap: ${err.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
