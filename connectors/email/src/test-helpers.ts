/** In-memory stand-in for the connector's state namespace in the core. */
import type { JsonValue } from '@247-agent/connector-sdk';

import { parseConfig, type IncomingConfig, type OutgoingConfig } from './config.js';
import type { StateStore } from './types.js';

export function incomingConfig(extra: Record<string, unknown> = {}): IncomingConfig {
  const c = parseConfig({ incoming: { host: 'h', ...extra } }).incoming;
  if (c === undefined) {
    throw new Error('unreachable');
  }
  return c;
}

export function outgoingConfig(extra: Record<string, unknown> = {}): OutgoingConfig {
  const c = parseConfig({
    outgoing: { host: 'smtp.example.cz', from: 'Orchestra <info@example.cz>', ...extra },
  }).outgoing;
  if (c === undefined) {
    throw new Error('unreachable');
  }
  return c;
}

export class MemoryState implements StateStore {
  readonly entries = new Map<string, JsonValue>();

  getState(key: string): Promise<JsonValue | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  putState(key: string, value: JsonValue): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
}
