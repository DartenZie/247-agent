/**
 * The webhook connector: an HTTP server that emits one event per verified request. A pure
 * emitter (`transport: none`): no ops, no MCP, stdout is free. Spawned by the core with the
 * manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { connectorEnv, CoreClient } from '@247-agent/connector-sdk';

import { parseConfig } from './config.js';
import { startServer } from './server.js';

const log = (line: string): void => {
  process.stderr.write(line + '\n');
};

const env = connectorEnv();
const config = parseConfig(env.config);
const core = new CoreClient({ socket: env.socket, name: env.name });
// A port in use or a socket path that cannot be created exits non-zero: the supervisor backs off.
const { server, address } = await startServer({ config, core, name: env.name, log });
log(
  `webhook: listening on ${address}, routes ${config.routes.map((r) => `${r.path} (${r.verify.kind})`).join(', ')}`,
);
for (const r of config.routes) {
  if (r.verify.kind === 'none') {
    log(`webhook: route ${r.path} accepts unauthenticated requests (verify: none)`);
  }
}

const shutdown = (): void => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
