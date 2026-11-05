import { createReadStream, statSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { pipeline } from 'node:stream';

import type { Logger } from '../log.js';
import { ApiError, route, type ApiResponse, type RouteContext } from './routes.js';
import { socketPathProblem } from './socket-path.js';

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

/**
 * Past `max` the rest of the body is read and discarded, not refused: closing the socket
 * while the client still writes gives it EPIPE or a reset instead of the 413 (#76).
 */
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > max) {
        reject(new BodyTooLargeError(`request body exceeds ${String(max)} bytes`));
        return;
      }
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

/** HTTP over a Unix socket (docs/internal/architecture.md); the CLI and connectors talk to this. */
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
    opts.core.metrics.apiRequests.inc({ method, status: String(response.status) });
    send(res, response, log);
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 1000;

  return {
    socketPath,
    listen: async () => {
      const tooLong = socketPathProblem(socketPath);
      if (tooLong !== undefined) {
        throw new Error(`cannot bind the socket: ${tooLong}`);
      }
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
      // Owner and group may connect: a connector in its own unit runs as another user in
      // the daemon's group (docs/internal/connectors.md) and must still reach /v1/events.
      try {
        await chmod(socketPath, 0o660);
      } catch (err) {
        log.warn('api.socket_mode_failed', { socket: socketPath, error: errorMessage(err) });
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

function send(res: ServerResponse, response: ApiResponse, log: Logger): void {
  if ('file' in response) {
    sendFile(res, response, log);
    return;
  }
  const text = 'text' in response ? response.text : JSON.stringify(response.body);
  res.writeHead(response.status, {
    'content-type': 'text' in response ? response.contentType : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Streams the file as the body and deletes it once sent, or once the client goes away. */
function sendFile(
  res: ServerResponse,
  response: { status: number; file: string; contentType: string },
  log: Logger,
): void {
  const { file } = response;
  const remove = (): void => {
    rm(file, { force: true }).catch((err: unknown) => {
      log.warn('api.file_remove_failed', { file, error: errorMessage(err) });
    });
  };
  // The client may have hung up while the file was being made; pipe() to a destroyed
  // stream throws on newer Node instead of calling back.
  if (res.destroyed || res.writableEnded) {
    log.warn('api.file_send_failed', { file, error: 'the client disconnected' });
    remove();
    return;
  }
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    log.error('api.file_send_failed', { file, error: errorMessage(err) });
    remove();
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal error' }));
    return;
  }
  res.writeHead(response.status, { 'content-type': response.contentType, 'content-length': size });
  const source = createReadStream(file);
  try {
    pipeline(source, res, (err) => {
      if (err) {
        log.warn('api.file_send_failed', { file, error: errorMessage(err) });
      }
      remove();
    });
  } catch (err) {
    log.warn('api.file_send_failed', { file, error: errorMessage(err) });
    source.destroy();
    res.destroy();
    remove();
  }
}
