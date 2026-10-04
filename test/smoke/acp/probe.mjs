// The `probe` connector of the ACP smoke rig (connectors.d/probe.yaml): one op, `stamp`,
// answering with SMOKE_PROBE_STAMP. Needs `npm run build` (it imports the SDK's dist/).
import process from 'node:process';

import { createConnectorServer, defineTool, serveStdio } from '@247-agent/connector-sdk';
import { z } from 'zod';

const stamp = process.env.SMOKE_PROBE_STAMP ?? 'unset';

const server = createConnectorServer({
  name: 'probe',
  tools: [
    defineTool({
      name: 'stamp',
      description: 'Returns the stamp of this smoke run. Pass the reference you were given.',
      input: { reference: z.string().optional() },
      handler: () => ({ stamp }),
    }),
  ],
});

await serveStdio(server);
