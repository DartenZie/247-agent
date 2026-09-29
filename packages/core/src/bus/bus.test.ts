import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Metrics } from '../metrics.js';
import { createBus } from './bus.js';
import { config, shell, testEnv, type TestEnv } from './testing.js';

let env: TestEnv;

beforeEach(() => {
  env = testEnv();
});

afterEach(() => {
  env.close();
});

describe('createBus', () => {
  it('labels events by type only when the config names the type, otherwise as other', () => {
    const metrics = new Metrics();
    const bus = createBus({ store: env.store, clock: env.clock, log: env.log, metrics });
    bus.setConfig(
      config([{ name: 'mail', trigger: { kind: 'event', type: 'email.received' }, action: shell }]),
    );
    bus.publish({ type: 'email.received', source: 'test', payload: null });
    bus.publish({ type: 'github.pr.1234', source: 'api', payload: null });
    bus.publish({ type: 'github.pr.1235', source: 'api', payload: null });
    const text = metrics.render();
    expect(text).toContain('oa_events_published_total{type="email.received",result="inserted"} 1');
    expect(text).toContain('oa_events_published_total{type="other",result="inserted"} 2');
    expect(text).not.toContain('github.pr');
  });
});
