import { describe, expect, it } from 'vitest';

import { Metrics, Registry } from './metrics.js';

describe('Registry', () => {
  it('renders counters, gauges and histograms in the exposition format', () => {
    const r = new Registry();
    const c = r.counter('t_total', 'a counter', ['task']);
    const g = r.gauge('t_gauge', 'a gauge');
    const h = r.histogram('t_seconds', 'a histogram', ['k'], [1, 0.5]);
    c.inc({ task: 'a' });
    c.inc({ task: 'a' }, 2);
    c.inc({ task: 'b "q"\n' });
    g.set(undefined, 4.5);
    h.observe({ k: 'x' }, 0.2);
    h.observe({ k: 'x' }, 0.7);
    h.observe({ k: 'x' }, 9);
    expect(r.render()).toBe(
      [
        '# HELP t_total a counter',
        '# TYPE t_total counter',
        't_total{task="a"} 3',
        't_total{task="b \\"q\\"\\n"} 1',
        '# HELP t_gauge a gauge',
        '# TYPE t_gauge gauge',
        't_gauge 4.5',
        '# HELP t_seconds a histogram',
        '# TYPE t_seconds histogram',
        't_seconds_bucket{k="x",le="0.5"} 1',
        't_seconds_bucket{k="x",le="1"} 2',
        't_seconds_bucket{k="x",le="+Inf"} 3',
        't_seconds_sum{k="x"} 9.9',
        't_seconds_count{k="x"} 3',
        '',
      ].join('\n'),
    );
    expect(r.value('t_total', { task: 'a' })).toBe(3);
    expect(r.value('t_seconds', { k: 'x' })).toBe(3);
    expect(r.value('t_gauge')).toBe(4.5);
    expect(r.value('nope')).toBeUndefined();
  });

  it('runs collectors before rendering and lets a gauge reset its series', () => {
    const r = new Registry();
    const g = r.gauge('up', 'up', ['name']);
    let n = 0;
    r.collect(() => {
      g.reset();
      g.set({ name: `c${String(n)}` }, 1);
      n++;
    });
    expect(r.render()).toContain('up{name="c0"} 1');
    const second = r.render();
    expect(second).toContain('up{name="c1"} 1');
    expect(second).not.toContain('c0');
  });

  it('rejects bad names, duplicate definitions, unknown labels and negative increments', () => {
    const r = new Registry();
    expect(() => r.counter('1bad', 'x')).toThrow(/invalid metric name/);
    expect(() => r.counter('ok', 'x', ['le'])).toThrow(/invalid label name/);
    const c = r.counter('ok', 'x', ['a']);
    expect(() => r.gauge('ok', 'x')).toThrow(/already defined/);
    expect(() => {
      c.inc({ b: '1' });
    }).toThrow(/unknown label "b"/);
    expect(() => {
      c.inc({ a: '1' }, -1);
    }).toThrow(/cannot decrease/);
  });
});

describe('Metrics', () => {
  it('defines the daemon metrics once and renders them all', () => {
    const m = new Metrics();
    m.buildInfo.set({ version: '1.2.3' }, 1);
    m.runsFinished.inc({ task: 't', status: 'succeeded' });
    const text = m.render();
    expect(text).toContain('oa_build_info{version="1.2.3"} 1');
    expect(text).toContain('oa_runs_finished_total{task="t",status="succeeded"} 1');
    expect(text).toContain('# TYPE oa_run_duration_seconds histogram');
    expect(text).toContain('# TYPE oa_connector_up gauge');
  });
});
