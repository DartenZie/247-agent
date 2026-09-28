/**
 * The install root ("home") of a running daemon: a release tree unpacked from the tarball
 * (`/opt/247-agent`, with `bin/`, `lib/`, `node/`, `share/`) or a source checkout (with
 * `bin/` and the workspace `dist/` directories). Both carry `bin/247-agent-core`, which
 * is the marker. The daemon puts `<home>/bin` and its own Node's directory first on PATH
 * for every child, so a manifest can say `exec: ["247-agent-connector-email"]` or
 * `exec: ["node", …]` and get this install's copies, wherever it lives.
 */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const HOME_ENV = 'OA_HOME';
const MARKER = join('bin', '247-agent-core');

/**
 * `$OA_HOME` if set (the launchers in `bin/` set it), else the nearest ancestor of
 * `mainScript` (normally `process.argv[1]`) that contains `bin/247-agent-core`; undefined
 * when neither applies (an unusual layout), in which case PATH is left alone.
 */
export function findHome(
  env: NodeJS.ProcessEnv,
  mainScript: string | undefined,
): string | undefined {
  const fromEnv = env[HOME_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  if (mainScript === undefined) {
    return undefined;
  }
  let dir = dirname(safeRealpath(mainScript));
  for (;;) {
    if (existsSync(join(dir, MARKER))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * The environment entries that make an install self-referential: `OA_HOME`, and PATH with
 * `<home>/bin` and the directory of the running Node (`execPath`) in front, each added
 * once. Apply to `process.env` before anything is spawned.
 */
export function homeEnv(
  home: string,
  env: NodeJS.ProcessEnv,
  execPath: string = process.execPath,
): { OA_HOME: string; PATH: string } {
  const current = (env.PATH ?? '').split(delimiter).filter((p) => p !== '');
  const front = [join(home, 'bin'), dirname(execPath)];
  const rest = current.filter((p) => !front.includes(p));
  return { OA_HOME: home, PATH: [...front, ...rest].join(delimiter) };
}

function safeRealpath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
