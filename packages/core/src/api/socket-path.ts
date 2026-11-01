/**
 * The longest Unix socket path in bytes: `sun_path` (108 on Linux, 104 on macOS and the
 * BSDs) less the terminating NUL that curl and Python need. Node 22 binds and dials a
 * longer path silently truncated (#62), so the socket lands under another name than the
 * one logged, and its `chmod` fails.
 */
export const MAX_SOCKET_PATH = process.platform === 'linux' ? 107 : 103;

/** Why `path` cannot be a Unix socket here, or undefined when it can. Counts UTF-8 bytes. */
export function socketPathProblem(path: string): string | undefined {
  const bytes = Buffer.byteLength(path);
  if (bytes <= MAX_SOCKET_PATH) {
    return undefined;
  }
  return (
    `${path} is ${String(bytes)} bytes, ${String(bytes - MAX_SOCKET_PATH)} over the ` +
    `${String(MAX_SOCKET_PATH)}-byte limit for a Unix socket path on ${process.platform}`
  );
}
