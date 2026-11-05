import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { Logger } from '../../log.js';
import { VERSION } from '../../version.js';
import type { Launched } from './index.js';

/** A client transport the core can close, with the pid of its child when it has one. */
export type McpTransport = Transport & { readonly pid?: number | null | undefined };

/** The core's MCP client for `transport`, its transport errors logged. */
export function mcpClient(transport: McpTransport, log: Logger): Client {
  transport.onerror = (err) => {
    log.warn('connector.transport_error', { error: err.message });
  };
  return new Client({ name: '247-agent-core', version: VERSION });
}

/**
 * `client.connect(transport)`, cut short by `signal`, which closes the transport. Rejects
 * on failure or abort only once the transport is closed, so a child it ran has exited.
 */
export async function connectUntil(
  client: Client,
  transport: McpTransport,
  signal: AbortSignal,
): Promise<void> {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= transport.close().catch(() => undefined));
  // The connect itself ends only when stdout closes, which a grandchild can hold open.
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  aborted.catch(() => undefined);
  const onAbort = (): void => {
    void close().then(() => {
      rejectAborted(signal.reason);
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const connecting = client.connect(transport);
    connecting.catch(() => undefined);
    await Promise.race([connecting, aborted]);
    // `initialize` may have been answered just as the abort came.
    signal.throwIfAborted();
  } catch (err) {
    await close();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A connected client as a `Launched`, ended with `closed` once its transport closes. */
export function mcpLaunched(client: Client, transport: McpTransport, closed: string): Launched {
  const ended = new Promise<string>((resolve) => {
    // Chain, not replace: the client's own handler rejects the ops in flight, which would
    // otherwise wait out their whole timeout on a connection that is gone.
    const clientOnClose = transport.onclose;
    transport.onclose = () => {
      clientOnClose?.();
      resolve(closed);
    };
  });
  return {
    get pid() {
      return transport.pid ?? null;
    },
    client,
    acp: undefined,
    ended,
    stop: () => transport.close().catch(() => undefined),
  };
}
