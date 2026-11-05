import { unitSocket } from '../../config/connector.js';
import { errorMessage } from '../../errors.js';
import { SocketClientTransport } from '../socket-transport.js';
import type { Launcher } from './index.js';
import { connectUntil, mcpClient, mcpLaunched } from './mcp.js';

/**
 * A `managed_by: systemd` connector with ops: its unit runs the process, so nothing is
 * spawned and no secret is resolved here; the core reaches it on the unit's socket.
 */
export const socketLauncher: Launcher = {
  async launch(req) {
    const path = unitSocket(req.manifest);
    const transport = new SocketClientTransport(path);
    const client = mcpClient(transport, req.log);
    try {
      await connectUntil(client, transport, req.signal);
    } catch (err) {
      throw new Error(
        `cannot connect to ${path} (is 247-agent-connector@${req.manifest.name} running?): ${errorMessage(err)}`,
        { cause: err },
      );
    }
    return mcpLaunched(client, transport, 'connection to the unit closed');
  },
};
