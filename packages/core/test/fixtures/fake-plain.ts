/**
 * A `transport: none` connector: no ops, it only emits one event on start and then idles
 * until killed. Exercises the supervisor's plain-process path.
 */
import { connectorEnv, CoreClient } from '../../../connector-sdk/src/index.ts';

const env = connectorEnv();
const core = new CoreClient({ socket: env.socket, name: env.name });
process.stderr.write(`fake-plain ${env.name} up\n`);
await core.emitEvent({ type: 'plain.started', payload: { name: env.name } });
setInterval(() => undefined, 60_000);
