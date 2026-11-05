import { join } from 'node:path';

import { buildSandboxArgv, type SandboxHost } from '../../actions/sandbox.js';
import { errorMessage } from '../../errors.js';
import { mkdirPrivate } from '../../private-fs.js';
import { AcpAgent } from '../acp.js';
import { sandboxOf } from '../child-env.js';
import type { NetProxy } from '../net-proxy.js';
import { childCommand, type Launched, type Launcher, type LaunchRequest } from './index.js';
import type { NetProxyPool } from './net-proxy-pool.js';
import { stopProcess } from './process.js';

/**
 * The home directory of a sandboxed agent program: inside `work_dir` (the one writable
 * path) and outside every run's workspace, so its caches and settings (`~/.npm`,
 * `~/.claude`) survive restarts and the retention sweep, which only takes `run_*` names.
 */
export function agentHome(workDir: string, connector: string): string {
  return join(workDir, 'home', connector);
}

export interface AcpLauncherOptions {
  /** `work_dir` as it is now: it moves on a reload. */
  workDir: () => string;
  /** What a sandboxed agent program must not see and must see. */
  sandboxHost: SandboxHost | undefined;
  /** The environment bwrap itself runs with, where it is found on PATH. */
  hostEnv: Record<string, string>;
  proxies: NetProxyPool;
}

/** An `acp` connector: an agent program, in bubblewrap when its manifest says so. */
export class AcpLauncher implements Launcher {
  constructor(private readonly opts: AcpLauncherOptions) {}

  async launch(req: LaunchRequest): Promise<Launched | undefined> {
    const { env } = childCommand(req);
    let agent: AcpAgent;
    let proxy: NetProxy | undefined;
    try {
      const spawn = await this.spawnArgs(req, env);
      proxy = spawn.proxy;
      if (!req.wanted()) {
        // Stopped, killed or replaced while the proxy was opening: start nothing.
        void proxy?.close();
        return undefined;
      }
      agent = await AcpAgent.spawn({
        exec: spawn.exec,
        cwd: spawn.cwd,
        env: spawn.env,
        log: req.log,
        outputLimiter: req.outputLimiter(),
        signal: req.signal,
      });
    } catch (err) {
      void proxy?.close();
      throw new Error(`cannot start: ${errorMessage(err)}`, { cause: err });
    }
    // The proxy serves this process alone: it goes when the process does, however.
    const ended = agent.exited.then(() => {
      void proxy?.close();
      return 'process exited';
    });
    return {
      get pid() {
        return agent.pid ?? null;
      },
      client: undefined,
      acp: agent,
      ended,
      stop: () => stopProcess(agent),
    };
  }

  /**
   * How the agent is started: as it is, or as `bwrap … -- <exec>` with `work_dir`
   * writable, its home under it, the manifest's `cwd` (else that home) as cwd and the
   * agent's environment set inside; bwrap itself runs with the host environment. With
   * `sandbox.network` the sandbox gets no network but the proxy opened here for its
   * `allow` list (none at all for an empty one).
   */
  private async spawnArgs(
    req: LaunchRequest,
    env: Record<string, string>,
  ): Promise<{
    exec: string[];
    cwd: string | undefined;
    env: Record<string, string>;
    proxy: NetProxy | undefined;
  }> {
    const m = req.manifest;
    const exec = m.exec ?? [];
    const sandbox = sandboxOf(m);
    if (sandbox === undefined) {
      return { exec, cwd: m.cwd, env, proxy: undefined };
    }
    const workDir = this.opts.workDir();
    const home = agentHome(workDir, m.name);
    // The agent's login and config live here: closed to other users like its workspaces.
    mkdirPrivate(home);
    const allow = sandbox.network?.allow ?? [];
    const proxy =
      allow.length === 0 ? undefined : await this.opts.proxies.openFor(m.name, allow, req.log);
    return {
      exec: buildSandboxArgv({
        sandbox,
        cmd: exec,
        writable: workDir,
        cwd: m.cwd ?? home,
        home,
        env,
        host: this.opts.sandboxHost,
        hostEnv: this.opts.hostEnv,
        net: sandbox.network === undefined ? undefined : { proxySocket: proxy?.socket },
      }),
      cwd: undefined,
      env: this.opts.hostEnv,
      proxy,
    };
  }
}
