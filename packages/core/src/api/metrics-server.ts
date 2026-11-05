import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ListenAddress } from '../config/agent.js';
import type { Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import { METRICS_CONTENT_TYPE } from './routes.js';

export interface MetricsServerOptions {
  log: Logger;
  metrics: Metrics;
}

/**
 * The scrape endpoint (`metrics.listen` in agent.yaml, #59): plain HTTP over TCP serving
 * `GET /metrics` and nothing else, so a Prometheus scrape job needs no proxy. It shares
 * no route with the socket API, which stays the only way to change anything.
 */
export interface MetricsServer {
  /** Where it listens now, with the port the kernel picked for port 0; undefined when off. */
  address(): ListenAddress | undefined;
  /**
   * Listens on `listen`, or stops for undefined. The same address keeps the listener; a
   * new one is bound before the old one closes, and a bind that fails rejects and leaves
   * the old listener serving.
   */
  configure(listen: ListenAddress | undefined): Promise<void>;
  close(): Promise<void>;
}

/** `host:port`, with an IPv6 host in brackets, as written in agent.yaml. */
export function formatListen(listen: ListenAddress): string {
  const host = listen.host.includes(':') ? `[${listen.host}]` : listen.host;
  return `${host}:${String(listen.port)}`;
}

function sameAddress(a: ListenAddress | undefined, b: ListenAddress | undefined): boolean {
  return a?.host === b?.host && a?.port === b?.port;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const { log, metrics } = opts;
  // What the config asked for (port 0 stays 0) and the listener serving it.
  let current: { wanted: ListenAddress; server: Server; bound: ListenAddress } | undefined;
  let queue: Promise<void> = Promise.resolve();

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://metrics').pathname;
    const method = req.method ?? 'GET';
    req.resume();
    if (path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res
        .writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
        .end('method not allowed\n');
      return;
    }
    const text = metrics.render();
    res.writeHead(200, {
      'content-type': METRICS_CONTENT_TYPE,
      'content-length': Buffer.byteLength(text),
    });
    res.end(method === 'HEAD' ? undefined : text);
  };

  const bind = (listen: ListenAddress): Promise<Server> => {
    const server = createServer(onRequest);
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        reject(
          new Error(`cannot listen for metrics on ${formatListen(listen)}: ${errorMessage(err)}`, {
            cause: err,
          }),
        );
      });
      server.listen(listen.port, listen.host, () => {
        resolve(server);
      });
    });
  };

  const stop = async (server: Server, bound: ListenAddress): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
    log.info('metrics.closed', { listen: formatListen(bound) });
  };

  const apply = async (listen: ListenAddress | undefined): Promise<void> => {
    if (current !== undefined && sameAddress(current.wanted, listen)) {
      return;
    }
    if (listen === undefined) {
      if (current !== undefined) {
        const old = current;
        current = undefined;
        await stop(old.server, old.bound);
      }
      return;
    }
    const old = current;
    let server: Server;
    try {
      server = await bind(listen);
    } catch (err) {
      // Same port, new host (127.0.0.1:9464 → 0.0.0.0:9464): the old listener is in the
      // way, so it goes first and comes back if the new address still cannot be bound.
      if (old?.bound.port !== listen.port) {
        throw err;
      }
      current = undefined;
      await stop(old.server, old.bound);
      try {
        server = await bind(listen);
      } catch (retryErr) {
        await apply(old.wanted).catch(() => undefined);
        throw retryErr;
      }
      current = { wanted: listen, server, bound: listen };
      log.info('metrics.listening', { listen: formatListen(listen) });
      return;
    }
    const a = server.address();
    const bound =
      a !== null && typeof a === 'object' ? { host: listen.host, port: a.port } : listen;
    current = { wanted: listen, server, bound };
    log.info('metrics.listening', { listen: formatListen(bound) });
    if (old !== undefined) {
      await stop(old.server, old.bound);
    }
  };

  const serialised = (fn: () => Promise<void>): Promise<void> => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    address: () => (current === undefined ? undefined : { ...current.bound }),
    configure: (listen) => serialised(() => apply(listen)),
    close: () => serialised(() => apply(undefined)),
  };
}
