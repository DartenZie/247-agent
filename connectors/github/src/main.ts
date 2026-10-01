/**
 * The github connector: a thin REST wrapper, ops only (poll it with the built-in poller).
 * Every op takes an optional `repo` (`owner/name`, or `owner` + `repo`) that must be one
 * of the configured `repos`; see README.md.
 */
import { z } from 'zod';

import { defineTool, runConnector } from '@247-agent/connector-sdk';

import { createGitHubApi, GitHubError } from './api.js';
import { parseConfig } from './config.js';
import { GitHubOps } from './ops.js';

const repoArgs = {
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
};
const limit = z.number().int().min(1).max(1000).optional();
const number = z.number().int().positive();
const state = z.enum(['open', 'closed', 'all']).optional();
const direction = z.enum(['asc', 'desc']).optional();
const timestamp = z.string().min(1).optional();

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
    return [
      defineTool({
        name: 'list_pull_requests',
        description:
          'Pull requests of a configured repository, newest first. Returns {repo, pull_requests: [{number, title, state, draft, url, user, labels, head, base, created_at, updated_at, closed_at, merged_at}]}.',
        input: {
          ...repoArgs,
          state,
          base: z.string().optional(),
          head: z.string().optional(),
          sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional(),
          direction,
          limit,
        },
        handler: (args) => o.listPullRequests(args),
      }),
      defineTool({
        name: 'get_pull_request',
        description:
          'One pull request with its body, merge state and size. Returns the list fields plus {body, merged, mergeable, mergeable_state, additions, deletions, changed_files, commits, requested_reviewers}.',
        input: { ...repoArgs, number },
        handler: (args) => o.getPullRequest(args),
      }),
      defineTool({
        name: 'get_pull_request_diff',
        description:
          'The unified diff of a pull request, cut at max_text characters. Returns {repo, number, diff, truncated}.',
        input: { ...repoArgs, number },
        handler: (args) => o.getPullRequestDiff(args),
      }),
      defineTool({
        name: 'list_issues',
        description:
          'Issues (not pull requests) of a configured repository. Returns {repo, issues: [{number, title, state, state_reason, url, user, labels, assignees, comments, created_at, updated_at, closed_at}]}.',
        input: {
          ...repoArgs,
          state,
          labels: z.array(z.string().min(1)).optional(),
          assignee: z.string().optional(),
          since: timestamp,
          sort: z.enum(['created', 'updated', 'comments']).optional(),
          direction,
          limit,
        },
        handler: (args) => o.listIssues(args),
      }),
      defineTool({
        name: 'get_issue',
        description:
          'One issue (or pull request) with its body. Returns the list fields plus {body, is_pull_request}.',
        input: { ...repoArgs, number },
        handler: (args) => o.getIssue(args),
      }),
      defineTool({
        name: 'list_comments',
        description:
          'The conversation comments of an issue or pull request, oldest first. Returns {repo, number, comments: [{id, url, user, body, created_at, updated_at}]}.',
        input: { ...repoArgs, number, since: timestamp, limit },
        handler: (args) => o.listComments(args),
      }),
      defineTool({
        name: 'list_commits',
        description:
          'Commits of a branch (sha: a branch, tag or commit; default branch when unset), newest first. Returns {repo, commits: [{sha, url, message, author, date}]}.',
        input: {
          ...repoArgs,
          sha: z.string().optional(),
          path: z.string().optional(),
          since: timestamp,
          limit,
        },
        handler: (args) => o.listCommits(args),
      }),
      defineTool({
        name: 'list_workflow_runs',
        description:
          'GitHub Actions runs, newest first; workflow is a file name (ci.yml) or id. Returns {repo, workflow_runs: [{id, name, url, event, status, conclusion, branch, sha, run_number, run_attempt, created_at, updated_at}]}.',
        input: {
          ...repoArgs,
          workflow: z.string().optional(),
          branch: z.string().optional(),
          event: z.string().optional(),
          status: z.string().optional(),
          limit,
        },
        handler: (args) => o.listWorkflowRuns(args),
      }),
      defineTool({
        name: 'search_issues',
        description:
          'GitHub issue search (is:issue, is:pr, label:, author:, …) within one configured repository. Returns {repo, issues: [… , is_pull_request]}.',
        input: { ...repoArgs, query: z.string().min(1), limit },
        handler: (args) => o.searchIssues(args),
      }),
      defineTool({
        name: 'create_issue',
        description: 'Opens an issue. Returns {repo, number, url}.',
        input: {
          ...repoArgs,
          title: z.string().min(1),
          body: z.string().optional(),
          labels: z.array(z.string().min(1)).optional(),
          assignees: z.array(z.string().min(1)).optional(),
        },
        handler: (args) => o.createIssue(args),
      }),
      defineTool({
        name: 'update_issue',
        description:
          'Edits an issue or pull request: title, body, state (open|closed), state_reason, labels (replaces them), assignees. Returns the issue fields.',
        input: {
          ...repoArgs,
          number,
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          state: z.enum(['open', 'closed']).optional(),
          state_reason: z.enum(['completed', 'not_planned', 'reopened']).optional(),
          labels: z.array(z.string().min(1)).optional(),
          assignees: z.array(z.string().min(1)).optional(),
        },
        handler: (args) => o.updateIssue(args),
      }),
      defineTool({
        name: 'add_comment',
        description: 'Comments on an issue or pull request. Returns {repo, id, url}.',
        input: { ...repoArgs, number, body: z.string().min(1) },
        handler: (args) => o.addComment(args),
      }),
      defineTool({
        name: 'add_labels',
        description:
          'Adds labels to an issue or pull request. Returns {repo, number, labels} (all labels now on it).',
        input: { ...repoArgs, number, labels: z.array(z.string().min(1)).min(1) },
        handler: (args) => o.addLabels(args),
      }),
      defineTool({
        name: 'remove_label',
        description: 'Removes one label. Returns {repo, number, labels} (the labels left).',
        input: { ...repoArgs, number, label: z.string().min(1) },
        handler: (args) => o.removeLabel(args),
      }),
      defineTool({
        name: 'create_pull_request',
        description:
          'Opens a pull request from head (a branch) into base. Returns {repo, number, url}.',
        input: {
          ...repoArgs,
          title: z.string().min(1),
          head: z.string().min(1),
          base: z.string().min(1),
          body: z.string().optional(),
          draft: z.boolean().optional(),
        },
        handler: (args) => o.createPullRequest(args),
      }),
    ];
  },
});
