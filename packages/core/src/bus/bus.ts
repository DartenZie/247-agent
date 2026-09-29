/**
 * The event bus: publish = append to the store + wake the dispatcher. The executor
 * (`executor/executor.ts`) subscribes with `onQueued` and publishes lifecycle events back.
 */
import type { Clock } from '../clock.js';
import type { Logger } from '../log.js';
import { Metrics } from '../metrics.js';
import type { Store } from '../store/store.js';
import type { NewEvent } from '../store/types.js';
import { Dispatcher, type DispatcherOptions, type QueuedListener } from './dispatcher.js';
import { labelledEventTypes, OTHER_EVENT_TYPE, type CompiledConfig } from './matcher.js';
import { publishEvent, type PublishResult } from './publish.js';

export interface EventBus {
  publish(input: NewEvent): PublishResult;
  readonly dispatcher: Dispatcher;
  /**
   * Activates a task config (start and reload): hands it to the dispatcher and rebuilds
   * the event types that keep their own `type` label on `oa_events_published_total`.
   */
  setConfig(config: CompiledConfig): void;
  onQueued(listener: QueuedListener): () => void;
}

export interface BusOptions extends Pick<DispatcherOptions, 'batchSize' | 'maxDepth'> {
  store: Store;
  clock: Clock;
  log: Logger;
  metrics?: Metrics | undefined;
}

export function createBus(opts: BusOptions): EventBus {
  const metrics = opts.metrics ?? new Metrics();
  const dispatcher = new Dispatcher({ ...opts, metrics });
  let labelled = labelledEventTypes({ tasks: [], byName: new Map() });
  return {
    dispatcher,
    setConfig: (config) => {
      dispatcher.setConfig(config);
      labelled = labelledEventTypes(config);
    },
    publish: (input) => {
      const result = publishEvent(opts.store, opts.clock, opts.log, input);
      const type = labelled.has(input.type) ? input.type : OTHER_EVENT_TYPE;
      metrics.eventsPublished.inc({ type, result: result.status });
      if (result.status === 'inserted') {
        dispatcher.wake();
      }
      return result;
    },
    onQueued: (listener) => dispatcher.onQueued(listener),
  };
}
