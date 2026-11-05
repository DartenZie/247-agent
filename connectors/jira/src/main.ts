/**
 * The jira connector: a thin REST wrapper for Jira Cloud or Data Center, ops only (poll it
 * with the built-in poller). Every op is confined to the configured `projects`; see
 * README.md.
 */
import { runConnector } from '@247-agent/connector-sdk';

import { createJiraApi } from './api.js';
import { parseConfig } from './config.js';
import { JiraOps } from './ops.js';
import { jiraTools } from './tools.js';

let ops: JiraOps | undefined;

await runConnector({
  version: '0.1.0',
  setup: async (rt) => {
    const config = parseConfig(rt.env.config);
    const api = createJiraApi(config);
    ops = new JiraOps(api, config);
    // Fails fast on bad credentials: the process exits non-zero and the supervisor backs off.
    const me = await api.request<{ displayName?: string; name?: string }>('GET', '/myself');
    rt.log(
      `jira: ${me.displayName ?? me.name ?? 'unknown user'} at ${config.base_url} (${config.deployment}), projects ${config.projects.join(', ')}`,
    );
  },
  tools: () => {
    const o = ops;
    if (o === undefined) {
      throw new Error('jira: setup did not run');
    }
    return jiraTools(o);
  },
});
