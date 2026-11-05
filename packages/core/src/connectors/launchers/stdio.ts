import { errorMessage } from '../../errors.js';
import { pipeLines } from '../output.js';
import { ProcessClientTransport } from '../stdio-transport.js';
import { childCommand, type Launcher } from './index.js';
import { connectUntil, mcpClient, mcpLaunched } from './mcp.js';

/** A `stdio` connector: an MCP server spawned with the protocol on its pipes, stderr logged. */
export const stdioLauncher: Launcher = {
  async launch(req) {
    const { command, args, env } = childCommand(req);
    const cwd = req.manifest.cwd;
    const transport = new ProcessClientTransport({
      command,
      args,
      env,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const client = mcpClient(transport, req.log);
    void pipeLines(transport.stderr, 'stderr', req.log, req.outputLimiter());
    try {
      await connectUntil(client, transport, req.signal);
    } catch (err) {
      throw new Error(`cannot start: ${errorMessage(err)}`, { cause: err });
    }
    return mcpLaunched(client, transport, 'process exited');
  },
};
