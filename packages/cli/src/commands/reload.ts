import { parseArgs } from 'node:util';

import { client, EXIT, reportApiError, UsageError, type Io } from '../io.js';

export const RELOAD_USAGE = `usage: oa reload [options]

Asks the daemon to re-read agent.yaml, the connector manifests and the tasks files and
apply them together, exactly like SIGHUP (systemctl reload 247-agent). Nothing changes
when any file is invalid; the issues are printed and the exit code is 1. Changes to db,
socket or secrets are reported and need a restart. Runs in flight finish under the
config they started with.

options:
  --json                print the report as JSON
  --socket <path>       daemon socket (default: $OA_CORE_SOCKET or /run/247-agent/core.sock)
`;

export async function reload(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      socket: { type: 'string' },
    },
  });
  if (positionals.length > 0) {
    throw new UsageError('reload takes no argument');
  }
  const api = client(values.socket);
  try {
    const r = await api.reload();
    if (values.json) {
      io.out(JSON.stringify(r));
      return r.ok ? EXIT.ok : EXIT.failed;
    }
    for (const f of r.files) {
      if (f.ok) {
        io.out(`ok ${f.file}`);
        continue;
      }
      for (const i of f.issues ?? []) {
        io.err(i.path === '' ? `${f.file}: ${i.message}` : `${f.file}: ${i.path}: ${i.message}`);
      }
    }
    if (!r.ok) {
      io.err('reload refused: the previous config stays active');
      return EXIT.failed;
    }
    const c = r.connectors;
    const changes =
      c === undefined
        ? ''
        : [
            c.added.length === 0 ? '' : `added ${c.added.join(', ')}`,
            c.removed.length === 0 ? '' : `removed ${c.removed.join(', ')}`,
            c.changed.length === 0 ? '' : `respawned ${c.changed.join(', ')}`,
          ]
            .filter((s) => s !== '')
            .join('; ');
    io.out(`reloaded: ${String(r.tasks)} tasks${changes === '' ? '' : `; connectors: ${changes}`}`);
    if (r.restart_required.length > 0) {
      io.err(`restart required for: ${r.restart_required.join(', ')}`);
    }
    return EXIT.ok;
  } catch (err) {
    return reportApiError(err, io);
  }
}
