/**
 * MCP over a Unix socket: the stdio framing (one JSON-RPC message per line) on a stream
 * socket instead of a child's stdin/stdout. The core's client side of a `managed_by:
 * systemd` connector, whose `247-agent-connector-host` bridges the socket to the
 * connector's own stdio.
 */
import { connect, type Socket } from 'node:net';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private socket: Socket | undefined;
  private readonly buffer = new ReadBuffer();
  private closed = false;

  constructor(
    readonly path: string,
    private readonly connectTimeoutMs = 10_000,
  ) {}

  /** Connects; rejects when nothing listens on the path (the unit is not running). */
  start(): Promise<void> {
    if (this.socket !== undefined) {
      return Promise.reject(new Error('SocketClientTransport already started'));
    }
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy(new Error(`timed out connecting to ${this.path}`));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onConnectError);
        socket.on('error', (err) => this.onerror?.(err));
        resolve();
      });
      const onConnectError = (err: Error): void => {
        clearTimeout(timer);
        this.closed = true;
        reject(err);
      };
      socket.once('error', onConnectError);
      socket.on('data', (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err instanceof Error ? err : new Error(String(err)));
            continue;
          }
          if (message === null) {
            break;
          }
          this.onmessage?.(message);
        }
      });
      socket.on('close', () => {
        this.buffer.clear();
        if (!this.closed) {
          this.closed = true;
          this.onclose?.();
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || this.closed) {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise((resolve, reject) => {
      socket.write(serializeMessage(message), (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || this.closed) {
      this.closed = true;
      return Promise.resolve();
    }
    this.closed = true;
    return new Promise((resolve) => {
      socket.once('close', () => {
        this.onclose?.();
        resolve();
      });
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    });
  }
}
