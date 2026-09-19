import { z } from 'zod';

import { DURATION, parseDuration } from '../config/duration.js';
import type { JsonValue } from '../store/types.js';
import { NonRetryableError, type ActionContext } from './types.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/** ARCHITECTURE §5.4: one MCP tool call on a connector. `args` values take `${…}` templates. */
export const ConnectorAction = z.strictObject({
  kind: z.literal('connector'),
  connector: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*'),
  op: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Per call; the task `timeout` still applies to the whole run. */
  timeout: z.string().regex(DURATION, 'durations look like 30s, 15m, 24h').optional(),
});

export type ConnectorActionConfig = z.infer<typeof ConnectorAction>;

export async function runConnector(action: unknown, ctx: ActionContext): Promise<JsonValue> {
  const cfg = ConnectorAction.parse(action);
  if (ctx.connectors === undefined) {
    throw new NonRetryableError('no connector supervisor is configured');
  }
  if (!ctx.connectors.names().includes(cfg.connector)) {
    throw new NonRetryableError(`unknown connector "${cfg.connector}"`);
  }
  const args = ctx.render(cfg.args) as Record<string, JsonValue>;
  const startedAt = Date.now();
  const result = await ctx.connectors.call(cfg.connector, cfg.op, args, {
    signal: ctx.signal,
    timeoutMs: cfg.timeout === undefined ? undefined : parseDuration(cfg.timeout),
  });
  ctx.log.info('connector.called', {
    connector: cfg.connector,
    op: cfg.op,
    duration_ms: Date.now() - startedAt,
  });
  return result;
}
