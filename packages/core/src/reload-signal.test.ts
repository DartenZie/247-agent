import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { listenForReload } from './reload-signal.js';

describe('listenForReload', () => {
  it('handles a SIGHUP that arrives before start instead of leaving it to the default action', () => {
    const proc = new EventEmitter();
    const handle = listenForReload(proc);
    expect(proc.listenerCount('SIGHUP')).toBe(1);
    proc.emit('SIGHUP');
    handle.cancel();
  });

  it('defers a SIGHUP received during startup and reloads once when the daemon is up', () => {
    const proc = new EventEmitter();
    const early = vi.fn();
    const handle = listenForReload(proc, { onDeferred: early });
    proc.emit('SIGHUP');
    proc.emit('SIGHUP');
    expect(early).toHaveBeenCalledTimes(2);
    const reload = vi.fn();
    handle.start(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on start when no SIGHUP arrived during startup', () => {
    const proc = new EventEmitter();
    const handle = listenForReload(proc);
    const reload = vi.fn();
    handle.start(reload);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads on every SIGHUP after start', () => {
    const proc = new EventEmitter();
    const handle = listenForReload(proc);
    const reload = vi.fn();
    handle.start(reload);
    proc.emit('SIGHUP');
    proc.emit('SIGHUP');
    expect(reload).toHaveBeenCalledTimes(2);
    expect(proc.listenerCount('SIGHUP')).toBe(1);
  });

  it('removes its listener when startup fails', () => {
    const proc = new EventEmitter();
    const handle = listenForReload(proc);
    handle.cancel();
    expect(proc.listenerCount('SIGHUP')).toBe(0);
  });
});
