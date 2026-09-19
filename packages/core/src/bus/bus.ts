/**
 * The event bus: publish = append to the store + wake the dispatcher. The executor
 * (`executor/executor.ts`) subscribes with `onQueued` and publishes lifecycle events back.
 */
import type { Clock } from '../clock.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/store.js';
import type { NewEvent } from '../store/types.js';
import { Dispatcher, type DispatcherOptions, type QueuedListener } from './dispatcher.js';
import { publishEvent, type PublishResult } from './publish.js';

export interface EventBus {
  publish(input: NewEvent): PublishResult;
  readonly dispatcher: Dispatcher;
  onQueued(listener: QueuedListener): () => void;
}

export interface BusOptions extends Pick<DispatcherOptions, 'batchSize' | 'maxDepth'> {
  store: Store;
  clock: Clock;
  log: Logger;
}

export function createBus(opts: BusOptions): EventBus {
  const dispatcher = new Dispatcher(opts);
  return {
    dispatcher,
    publish: (input) => {
      const result = publishEvent(opts.store, opts.clock, opts.log, input);
      if (result.status === 'inserted') {
        dispatcher.wake();
      }
      return result;
    },
    onQueued: (listener) => dispatcher.onQueued(listener),
  };
}
