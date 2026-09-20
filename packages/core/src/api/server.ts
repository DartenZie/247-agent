import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';

import type { Logger } from '../log.js';
import type { JsonValue } from '../store/types.js';
import { ApiError, route, type ApiResponse, type RouteContext } from './routes.js';

export interface ApiServerOptions extends RouteContext {
  log: Logger;
  socketPath: string;
  /** Request bodies larger than this are rejected with 413. */
  maxBodyBytes?: number;
}

export interface ApiServer {
  readonly socketPath: string;
  /** Binds the Unix socket. A stale socket file from a dead daemon is removed first. */
  listen(): Promise<void>;
  /** Stops accepting requests, drops open connections, removes the socket file. */
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new BodyTooLargeError(`request body exceeds ${String(max)} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** True when something accepts connections on the socket path. */
function socketInUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

function bind(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

/** HTTP over a Unix socket (ARCHITECTURE §4); the CLI and connectors talk to this. */
export function createApiServer(opts: ApiServerOptions): ApiServer {
  const { log, socketPath } = opts;
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://unix');
    let response: ApiResponse;
    try {
      const raw = await readBody(req, maxBody);
      let body: unknown;
      if (raw !== '') {
        try {
          body = JSON.parse(raw) as unknown;
        } catch (err) {
          throw new ApiError(400, `invalid JSON body: ${errorMessage(err)}`, undefined, {
            cause: err,
          });
        }
      }
      response = await route(opts, { method, path: url.pathname, query: url.searchParams, body });
    } catch (err) {
      if (err instanceof ApiError) {
        response = err.toResponse();
      } else if (err instanceof BodyTooLargeError) {
        response = new ApiError(413, err.message).toResponse();
      } else {
        log.error('api.request_failed', { method, path: url.pathname, error: errorMessage(err) });
        response = { status: 500, body: { error: 'internal error' } };
      }
    }
    log.debug('api.request', { method, path: url.pathname, status: response.status });
    send(res, response.status, response.body);
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 1000;

  return {
    socketPath,
    listen: async () => {
      try {
        await bind(server, socketPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw err;
        }
        if (await socketInUse(socketPath)) {
          throw new Error(`another daemon is listening on ${socketPath}`, { cause: err });
        }
        log.warn('api.stale_socket_removed', { socket: socketPath });
        await rm(socketPath, { force: true });
        await bind(server, socketPath);
      }
      log.info('api.listening', { socket: socketPath });
    },
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await rm(socketPath, { force: true });
      log.info('api.closed', { socket: socketPath });
    },
  };
}

function send(res: ServerResponse, status: number, body: JsonValue): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
