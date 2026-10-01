/**
 * The ops, over the REST client. Every op resolves its repository against `repos` first,
 * so a task or an agent can never reach a repository the manifest does not name. Results
 * are slimmed to the fields a workflow reads; list ops wrap their array in an object
 * (`{pull_requests: […]}`) so the built-in poller's `items` has a name to point at.
 */
import type { JsonValue } from '@247-agent/connector-sdk';

import type { GitHubApi } from './api.js';
import type { GitHubConfig } from './config.js';

type Json = Record<string, JsonValue>;

/** `owner` + `repo`, or `repo` as `owner/name`, or nothing for the first configured one. */
export interface RepoArgs {
  owner?: string | undefined;
  repo?: string | undefined;
}

export interface ListArgs extends RepoArgs {
  /** Items wanted, 1..1000; fetched 100 per page. */
  limit?: number | undefined;
}

interface GhUser {
  login: string;
}

interface GhLabel {
  name: string;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  html_url: string;
  user: GhUser | null;
  labels: (GhLabel | string)[];
  assignees?: GhUser[] | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body?: string | null;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  user: GhUser | null;
  labels: GhLabel[];
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  body?: string | null;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  requested_reviewers?: GhUser[];
}

interface GhComment {
  id: number;
  html_url: string;
  user: GhUser | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: GhUser | null;
}

interface GhRun {
  id: number;
  name?: string | null;
  html_url: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  run_number: number;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
}

export class GitHubOps {
  constructor(
    private readonly api: GitHubApi,
    private readonly config: GitHubConfig,
  ) {}

  /** `owner/name`, checked against `repos`; throws for anything else. */
  resolveRepo(args: RepoArgs): string {
    let full: string;
    if (args.repo === undefined && args.owner === undefined) {
      full = this.config.repos[0] ?? '';
    } else if (args.repo?.includes('/') === true) {
      if (
        args.owner !== undefined &&
        !args.repo.toLowerCase().startsWith(`${args.owner.toLowerCase()}/`)
      ) {
        throw new Error(`repo "${args.repo}" does not belong to owner "${args.owner}"`);
      }
      full = args.repo;
    } else if (args.repo !== undefined && args.owner !== undefined) {
      full = `${args.owner}/${args.repo}`;
    } else {
      throw new Error('name the repository as repo: "owner/name", or both owner and repo');
    }
    full = full.toLowerCase();
    if (!this.config.repos.includes(full)) {
      throw new Error(`repository "${full}" is not in the connector's repos`);
    }
    return full;
  }

  async listPullRequests(
    args: ListArgs & {
      state?: 'open' | 'closed' | 'all' | undefined;
      base?: string | undefined;
      head?: string | undefined;
      sort?: 'created' | 'updated' | 'popularity' | 'long-running' | undefined;
      direction?: 'asc' | 'desc' | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const pulls = await this.paged<GhPull>(`/repos/${repo}/pulls`, args.limit ?? 30, {
      state: args.state ?? 'open',
      base: args.base,
      head: args.head,
      sort: args.sort,
      direction: args.direction,
    });
    return { repo, pull_requests: pulls.map((p) => pullSummary(p)) };
  }

  async getPullRequest(args: RepoArgs & { number: number }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const p = await this.api.request<GhPull>('GET', `/repos/${repo}/pulls/${String(args.number)}`);
    return {
      ...pullSummary(p),
      repo,
      body: this.clip(p.body ?? ''),
      merged: p.merged ?? p.merged_at !== null,
      mergeable: p.mergeable ?? null,
      mergeable_state: p.mergeable_state ?? null,
      additions: p.additions ?? null,
      deletions: p.deletions ?? null,
      changed_files: p.changed_files ?? null,
      commits: p.commits ?? null,
      requested_reviewers: (p.requested_reviewers ?? []).map((u) => u.login),
    };
  }

  /** The unified diff, cut at `max_text` characters. */
  async getPullRequestDiff(args: RepoArgs & { number: number }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const diff = await this.api.text('GET', `/repos/${repo}/pulls/${String(args.number)}`, {
      accept: 'application/vnd.github.diff',
    });
    const truncated = diff.length > this.config.max_text;
    return { repo, number: args.number, diff: this.clip(diff), truncated };
  }

  /** Issues only; GitHub's issues endpoint also returns pull requests, which are dropped. */
  async listIssues(
    args: ListArgs & {
      state?: 'open' | 'closed' | 'all' | undefined;
      labels?: string[] | undefined;
      assignee?: string | undefined;
      since?: string | undefined;
      sort?: 'created' | 'updated' | 'comments' | undefined;
      direction?: 'asc' | 'desc' | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const limit = args.limit ?? 30;
    const items = await this.paged<GhIssue>(
      `/repos/${repo}/issues`,
      limit,
      {
        state: args.state ?? 'open',
        labels: args.labels?.join(','),
        assignee: args.assignee,
        since: args.since,
        sort: args.sort,
        direction: args.direction,
      },
      (i) => i.pull_request === undefined,
    );
    return { repo, issues: items.map((i) => issueSummary(i)) };
  }

  async getIssue(args: RepoArgs & { number: number }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const i = await this.api.request<GhIssue>(
      'GET',
      `/repos/${repo}/issues/${String(args.number)}`,
    );
    return {
      ...issueSummary(i),
      repo,
      is_pull_request: i.pull_request !== undefined,
      body: this.clip(i.body ?? ''),
    };
  }

  /** Comments of an issue or a pull request (the conversation, not review comments). */
  async listComments(
    args: ListArgs & { number: number; since?: string | undefined },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const comments = await this.paged<GhComment>(
      `/repos/${repo}/issues/${String(args.number)}/comments`,
      args.limit ?? 30,
      { since: args.since },
    );
    return {
      repo,
      number: args.number,
      comments: comments.map((c) => ({
        id: c.id,
        url: c.html_url,
        user: c.user?.login ?? null,
        body: this.clip(c.body ?? ''),
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    };
  }

  async listCommits(
    args: ListArgs & {
      sha?: string | undefined;
      path?: string | undefined;
      since?: string | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const commits = await this.paged<GhCommit>(`/repos/${repo}/commits`, args.limit ?? 30, {
      sha: args.sha,
      path: args.path,
      since: args.since,
    });
    return {
      repo,
      commits: commits.map((c) => ({
        sha: c.sha,
        url: c.html_url,
        message: c.commit.message,
        author: c.author?.login ?? c.commit.author?.name ?? null,
        date: c.commit.author?.date ?? null,
      })),
    };
  }

  async listWorkflowRuns(
    args: ListArgs & {
      workflow?: string | undefined;
      branch?: string | undefined;
      event?: string | undefined;
      status?: string | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const path =
      args.workflow === undefined
        ? `/repos/${repo}/actions/runs`
        : `/repos/${repo}/actions/workflows/${encodeURIComponent(args.workflow)}/runs`;
    const runs = await this.paged<GhRun>(
      path,
      args.limit ?? 30,
      { branch: args.branch, event: args.event, status: args.status },
      undefined,
      'workflow_runs',
    );
    return {
      repo,
      workflow_runs: runs.map((r) => ({
        id: r.id,
        name: r.name ?? null,
        url: r.html_url,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        sha: r.head_sha,
        run_number: r.run_number,
        run_attempt: r.run_attempt ?? 1,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  }

  /** GitHub's issue search, always restricted to one configured repository. */
  async searchIssues(args: ListArgs & { query: string }): Promise<Json> {
    const repo = this.resolveRepo(args);
    if (/(^|\s)(repo|org|user|owner):/i.test(args.query)) {
      throw new Error('the query must not name repo:, org:, user: or owner: (the op scopes it)');
    }
    const items = await this.paged<GhIssue>(
      '/search/issues',
      Math.min(args.limit ?? 30, 1000),
      { q: `${args.query} repo:${repo}` },
      undefined,
      'items',
    );
    return {
      repo,
      issues: items.map((i) => ({
        ...issueSummary(i),
        is_pull_request: i.pull_request !== undefined,
      })),
    };
  }

  async createIssue(
    args: RepoArgs & {
      title: string;
      body?: string | undefined;
      labels?: string[] | undefined;
      assignees?: string[] | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const i = await this.api.request<GhIssue>('POST', `/repos/${repo}/issues`, {
      body: { title: args.title, body: args.body, labels: args.labels, assignees: args.assignees },
    });
    return { repo, number: i.number, url: i.html_url };
  }

  async updateIssue(
    args: RepoArgs & {
      number: number;
      title?: string | undefined;
      body?: string | undefined;
      state?: 'open' | 'closed' | undefined;
      state_reason?: 'completed' | 'not_planned' | 'reopened' | undefined;
      labels?: string[] | undefined;
      assignees?: string[] | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const { owner: _o, repo: _r, number, ...fields } = args;
    const i = await this.api.request<GhIssue>('PATCH', `/repos/${repo}/issues/${String(number)}`, {
      body: fields,
    });
    return { ...issueSummary(i), repo };
  }

  /** A comment on an issue or a pull request. */
  async addComment(args: RepoArgs & { number: number; body: string }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const c = await this.api.request<GhComment>(
      'POST',
      `/repos/${repo}/issues/${String(args.number)}/comments`,
      { body: { body: args.body } },
    );
    return { repo, id: c.id, url: c.html_url };
  }

  async addLabels(args: RepoArgs & { number: number; labels: string[] }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const labels = await this.api.request<GhLabel[]>(
      'POST',
      `/repos/${repo}/issues/${String(args.number)}/labels`,
      { body: { labels: args.labels } },
    );
    return { repo, number: args.number, labels: labels.map((l) => l.name) };
  }

  async removeLabel(args: RepoArgs & { number: number; label: string }): Promise<Json> {
    const repo = this.resolveRepo(args);
    const labels = await this.api.request<GhLabel[]>(
      'DELETE',
      `/repos/${repo}/issues/${String(args.number)}/labels/${encodeURIComponent(args.label)}`,
    );
    return { repo, number: args.number, labels: labels.map((l) => l.name) };
  }

  async createPullRequest(
    args: RepoArgs & {
      title: string;
      head: string;
      base: string;
      body?: string | undefined;
      draft?: boolean | undefined;
    },
  ): Promise<Json> {
    const repo = this.resolveRepo(args);
    const p = await this.api.request<GhPull>('POST', `/repos/${repo}/pulls`, {
      body: {
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
        draft: args.draft,
      },
    });
    return { repo, number: p.number, url: p.html_url };
  }

  /**
   * Pages until `limit` items (after `keep`) or the last page: `per_page` is the limit
   * itself when nothing is filtered out, else 100.
   */
  private async paged<T>(
    path: string,
    limit: number,
    query: Record<string, string | undefined>,
    keep?: (item: T) => boolean,
    field?: string,
  ): Promise<T[]> {
    const want = Math.max(1, Math.min(limit, 1000));
    const perPage = keep === undefined ? Math.min(100, want) : 100;
    const out: T[] = [];
    for (let page = 1; out.length < want; page++) {
      const body = await this.api.request<T[] | Record<string, T[] | undefined>>('GET', path, {
        query: { ...query, per_page: perPage, page },
      });
      const items = Array.isArray(body) ? body : field === undefined ? [] : (body[field] ?? []);
      out.push(...(keep === undefined ? items : items.filter(keep)));
      if (items.length < perPage) {
        break;
      }
    }
    return out.slice(0, want);
  }

  private clip(text: string): string {
    return text.length > this.config.max_text ? text.slice(0, this.config.max_text) : text;
  }
}

function pullSummary(p: GhPull): Json {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft ?? false,
    url: p.html_url,
    user: p.user?.login ?? null,
    labels: p.labels.map((l) => l.name),
    head: { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo?.full_name ?? null },
    base: { ref: p.base.ref, sha: p.base.sha },
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    merged_at: p.merged_at,
  };
}

function issueSummary(i: GhIssue): Json {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    state_reason: i.state_reason ?? null,
    url: i.html_url,
    user: i.user?.login ?? null,
    labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: (i.assignees ?? []).map((u) => u.login),
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
  };
}
