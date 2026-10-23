/**
 * MCP over a child's stdin/stdout, like the SDK's `StdioClientTransport`, but the child
 * leads a process group of its own and `close` signals the whole group. A connector whose
 * `exec` is a wrapper that starts the program as its own child (`sh -c "node server.js;
 * true"`) would otherwise leave the program running when only the wrapper is stopped,
 * next to its replacement after a restart (#196).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { exitOf, killGroup, releasePipes, sweepGroupAfter } from '../process-group.js';

export interface ProcessTransportOptions {
  command: string;
  args: string[];
  /** The whole environment: nothing is inherited from the daemon's. */
  env: Record<string, string>;
  cwd?: string;
  /** How long each step of `close` waits: stdin closed, then SIGTERM, then SIGKILL. */
  graceMs?: number;
}

export class ProcessClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** The child's stderr, available before `start` so that no early line is lost. */
  readonly stderr = new PassThrough();

  private child: ChildProcess | undefined;
  private closed: Promise<void> | undefined;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly opts: ProcessTransportOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Spawns the child; rejects when it cannot be spawned at all. */
  start(): Promise<void> {
    if (this.child !== undefined) {
      return Promise.reject(new Error('ProcessClientTransport already started'));
    }
    const { command, args, env, cwd } = this.opts;
    const child = spawn(command, args, {
      env,
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    // A spawn error rejects it too; `start` reports that one.
    const pipesClosed = once(child, 'close').catch(() => undefined);
    // The child exited: the rest of its group goes too, and with it the last holder of a
    // pipe of ours (#198). A holder outside the group loses the pipes after a grace (#200).
    const closed = sweepGroupAfter(child.pid, exitOf(child)).then(async () => {
      await releasePipes(child);
      await pipesClosed;
    });
    this.closed = closed;
    void closed.then(() => {
      if (!this.stderr.writableEnded) {
        this.stderr.end(); // a destroyed child.stderr does not end it
      }
      this.buffer.clear();
      this.onclose?.();
    });
    child.stdin.on('error', (err) => this.onerror?.(err));
    child.stdout.on('error', (err) => this.onerror?.(err));
    child.stderr.pipe(this.stderr);
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
      } catch (err) {
        // Over the read buffer's limit: the connector cannot be trusted to resync.
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        void this.close();
        return;
      }
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
    return new Promise((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (err) => {
        this.onerror?.(err);
        reject(err);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise((resolve, reject) => {
      stdin.write(serializeMessage(message), (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Closes stdin, then signals the group SIGTERM and at last SIGKILL, each after a grace,
   * until every process holding the child's pipes is gone. Resolves once they are closed.
   */
  async close(): Promise<void> {
    const child = this.child;
    const closed = this.closed;
    if (child === undefined || closed === undefined) {
      return;
    }
    const pid = child.pid;
    const grace = this.opts.graceMs ?? 2000;
    const within = (ms: number): Promise<boolean> =>
      Promise.race([closed.then(() => true), sleep(ms, false, { ref: false })]);
    child.stdin?.end();
    if (pid === undefined || (await within(grace))) {
      return;
    }
    killGroup(pid, 'SIGTERM');
    if (await within(grace)) {
      return;
    }
    killGroup(pid, 'SIGKILL');
    await within(grace);
  }
}
