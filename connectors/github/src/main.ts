/**
 * The github connector: a thin REST wrapper, ops only (poll it with the built-in poller).
 * Every op takes an optional `repo` (`owner/name`, or `owner` + `repo`) that must be one
 * of the configured `repos`; see README.md.
 */
import { runConnector } from '@247-agent/connector-sdk';

import { createGitHubApi, GitHubError } from './api.js';
import { parseConfig } from './config.js';
import { GitHubOps } from './ops.js';
import { githubTools } from './tools.js';

let ops: GitHubOps | undefined;

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    const config = parseConfig(rt.env.config);
    const api = createGitHubApi({
      token: config.token,
      apiBase: config.api_base,
      timeoutMs: config.timeout,
    });
    ops = new GitHubOps(api, config);
    // Fails fast on a bad token: the process exits non-zero and the supervisor backs off.
    const me = await api
      .request<{ login?: string } | null>('GET', '/user')
      .catch((err: unknown) => {
        // An installation token cannot read /user; any other failure is fatal.
        if (err instanceof GitHubError && err.status === 403) {
          return null;
        }
        throw err;
      });
    rt.log(
      `github: ${me?.login === undefined ? 'app token' : `@${me.login}`} at ${config.api_base}, repos ${config.repos.join(', ')}`,
    );
  },
  tools: () => {
    const o = ops;
    if (o === undefined) {
      throw new Error('github: setup did not run');
    }
    return githubTools(o);
  },
});
