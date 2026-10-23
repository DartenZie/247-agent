import { chmodSync, mkdirSync, statSync } from 'node:fs';

/**
 * Clears the other-user bits of `path`, which the database and workspaces must not carry
 * (issue #42). Skips a path that does not exist or that another user owns: the chmod
 * would fail, and refusing to start over it would be worse than the mode.
 */
export function closeToOthers(path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if ((st.mode & 0o007) === 0 || st.uid !== process.getuid?.()) {
    return;
  }
  chmodSync(path, st.mode & 0o770);
}

/** Creates `path` and its missing parents 0750, and closes an existing `path` to other users. */
export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o750 });
  closeToOthers(path);
}
