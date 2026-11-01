/**
 * The longest Unix socket path this platform binds as given: the size of `sun_path`, 108
 * bytes on Linux and 104 on macOS and the BSDs. Node 22 binds a longer path silently
 * truncated to this length (#62), so the socket lands under another name than the one
 * the daemon logs and `oa` dials.
 */
export const SOCKET_PATH_MAX = process.platform === 'linux' ? 108 : 104;

/** Why `path` cannot be a Unix socket here, or undefined when it can. Counts UTF-8 bytes. */
export function socketPathProblem(path: string): string | undefined {
  const bytes = Buffer.byteLength(path);
  if (bytes <= SOCKET_PATH_MAX) {
    return undefined;
  }
  return (
    `${path} is ${String(bytes)} bytes, ${String(bytes - SOCKET_PATH_MAX)} over the ` +
    `${String(SOCKET_PATH_MAX)}-byte limit for a Unix socket path on ${process.platform}`
  );
}
