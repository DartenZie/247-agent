import type { Clock } from '../clock.js';
import { validateEventType } from '../config/validators.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import type { EventRecord, NewEvent } from '../store/types.js';

export type PublishResult =
  { status: 'inserted'; event: EventRecord } | { status: 'duplicate'; dedup_key: string };

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

/**
 * Appends an event. Assigns `id` and `ts`; inherits `correlation_id` and `depth + 1` from
 * `parent_id` when given, otherwise starts a new correlation. A `dedup_key` collision drops
 * the event and reports `duplicate`.
 */
export function publishEvent(
  store: Store,
  clock: Clock,
  log: Logger,
  input: NewEvent,
): PublishResult {
  const typeError = validateEventType(input.type);
  if (typeError !== null) {
    throw new InvalidEventError(`invalid event type "${input.type}": ${typeError}`);
  }
  return store.transaction((): PublishResult => {
    let correlationId = input.correlation_id;
    let depth = 0;
    if (input.parent_id !== undefined) {
      const parent = store.events.getById(input.parent_id);
      if (parent === undefined) {
        throw new InvalidEventError(`unknown parent event "${input.parent_id}"`);
      }
      correlationId ??= parent.correlation_id;
      depth = parent.depth + 1;
    }
    const now = clock.now();
    const event: Omit<EventRecord, 'seq'> = {
      id: newId('evt', now),
      type: input.type,
      source: input.source,
      ts: now.toISOString(),
      correlation_id: correlationId ?? newId('cor', now),
      parent_id: input.parent_id ?? null,
      dedup_key: input.dedup_key ?? null,
      depth,
      payload: input.payload ?? null,
    };
    const res = store.events.insert(event);
    if (!res.inserted) {
      const dedupKey = event.dedup_key ?? '';
      log.debug('event.duplicate', { event_type: event.type, dedup_key: dedupKey });
      return { status: 'duplicate', dedup_key: dedupKey };
    }
    log.debug('event.published', {
      event_id: event.id,
      event_type: event.type,
      source: event.source,
      correlation_id: event.correlation_id,
    });
    return { status: 'inserted', event: { ...event, seq: res.seq } };
  });
}
