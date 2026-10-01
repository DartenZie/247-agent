/**
 * The jira connector: a thin REST wrapper for Jira Cloud or Data Center, ops only (poll it
 * with the built-in poller). Every op is confined to the configured `projects`; see
 * README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector } from '@247-agent/connector-sdk';

import { createJiraApi } from './api.js';
import { parseConfig } from './config.js';
import { JiraOps } from './ops.js';

const key = z.string().min(1);
const fieldIds = z.array(z.string().min(1)).optional();
const rawFields = z.record(z.string(), z.unknown()).optional();

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
    return [
      defineTool({
        name: 'search',
        description:
          'Issues matching a JQL query, confined to the configured projects (an empty query lists them all). Returns {jql, issues: [{key, id, url, project, summary, status, status_category, issue_type, priority, labels, assignee, reporter, created, updated, fields?}]}.',
        input: {
          jql: z.string(),
          fields: fieldIds,
          limit: z.number().int().min(1).max(1000).optional(),
        },
        handler: (args) => o.search(args),
      }),
      defineTool({
        name: 'get_issue',
        description:
          'One issue with its description as plain text, and its latest comments when comments > 0. Returns the search fields plus {description, comments?}.',
        input: { key, fields: fieldIds, comments: z.number().int().min(0).max(100).optional() },
        handler: (args) => o.getIssue(args),
      }),
      defineTool({
        name: 'list_comments',
        description:
          'The latest comments of an issue as plain text, oldest first. Returns {key, total, comments: [{id, author, body, created, updated}]}.',
        input: { key, limit: z.number().int().min(1).max(100).optional() },
        handler: (args) => o.listComments(args),
      }),
      defineTool({
        name: 'create_issue',
        description:
          'Creates an issue (project defaults to the first configured one, issue_type to Task); description is plain text. Returns {key, id, url}.',
        input: {
          project: z.string().min(1).optional(),
          issue_type: z.string().min(1).optional(),
          summary: z.string().min(1),
          description: z.string().optional(),
          labels: z.array(z.string().min(1)).optional(),
          priority: z.string().min(1).optional(),
          fields: rawFields,
        },
        handler: (args) => o.createIssue(args),
      }),
      defineTool({
        name: 'update_issue',
        description:
          'Edits summary, description (plain text), labels (replaces them), priority, or raw fields. Returns {key, updated}.',
        input: {
          key,
          summary: z.string().min(1).optional(),
          description: z.string().optional(),
          labels: z.array(z.string().min(1)).optional(),
          priority: z.string().min(1).optional(),
          fields: rawFields,
        },
        handler: (args) => o.updateIssue(args),
      }),
      defineTool({
        name: 'add_comment',
        description: 'Comments on an issue (plain text). Returns {key, id, url}.',
        input: { key, body: z.string().min(1) },
        handler: (args) => o.addComment(args),
      }),
      defineTool({
        name: 'list_transitions',
        description:
          'The workflow transitions available on an issue now. Returns {key, transitions: [{id, name, to}]}.',
        input: { key },
        handler: (args) => o.listTransitions(args),
      }),
      defineTool({
        name: 'transition_issue',
        description:
          'Moves an issue through a transition, named by its name, its id or the status it leads to; optional comment. Returns {key, transition, status}.',
        input: {
          key,
          transition: z.string().min(1),
          comment: z.string().min(1).optional(),
          fields: rawFields,
        },
        handler: (args) => o.transitionIssue(args),
      }),
    ];
  },
});
