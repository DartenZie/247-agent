import { existsSync, mkdirSync, rmdirSync } from 'node:fs';

import { netProxySocket } from '../../actions/sandbox-net.js';
import type { Logger } from '../../log.js';
import type { Metrics } from '../../metrics.js';
import { openNetProxy, type NetProxy } from '../net-proxy.js';

/**
 * The filtering proxies of sandboxes with a network allowlist (`connectors/net-proxy.ts`):
 * sockets in the daemon's runtime directory (`netProxyDir`), which every sandbox masks and
 * no bind may show (`sandboxHost`, `checkSandboxes`), so no sandbox sees one unless bwrap
 * binds it in and one agent cannot borrow another's allowlist. The pid in each name keeps
 * a second daemon started on the same config, which fails only once it binds the core
 * socket, off this one's sockets.
 */
export class NetProxyPool {
  private readonly dir: string;
  private readonly metrics: Metrics;
  private seq = 0;
  private readonly open = new Set<NetProxy>();

  constructor(opts: { dir: string; metrics: Metrics }) {
    this.dir = opts.dir;
    this.metrics = opts.metrics;
  }

  /** A proxy for `connector`'s `allow` list; the caller closes it when the program is gone. */
  async openFor(connector: string, allow: readonly string[], log: Logger): Promise<NetProxy> {
    if (!existsSync(this.dir)) {
      // Not recursive: the runtime directory is the operator's to make, with its own mode.
      mkdirSync(this.dir, { mode: 0o700 });
    }
    const proxy = await openNetProxy({
      allow,
      socket: netProxySocket(this.dir, process.pid, ++this.seq),
      log,
      onRequest: (result) => {
        this.metrics.sandboxNetRequests.inc({ connector, result });
      },
    });
    this.open.add(proxy);
    return {
      socket: proxy.socket,
      close: () => {
        this.open.delete(proxy);
        return proxy.close();
      },
    };
  }

  /** Closes every proxy still open, then removes the directory if nothing else is in it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.open].map((p) => p.close()));
    try {
      // Each proxy removed its socket; the directory goes only if nothing else is in it.
      rmdirSync(this.dir);
    } catch {
      // never made, or not empty
    }
  }
}
