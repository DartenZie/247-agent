import { describe, expect, it } from 'vitest';

import { createGitHubApi, GitHubError } from './api.js';
import { parseConfig } from './config.js';
import { GitHubOps } from './ops.js';

const TOKEN = 'ghp_secret';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

type Route = (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> };

/** A fake api.github.com behind the injected fetch: routes by "METHOD /path". */
class FakeGitHub {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Route>();

  on(key: string, route: Route): this {
    this.routes.set(key, route);
    return this;
  }

  ops(config: Record<string, unknown> = {}): GitHubOps {
    const cfg = parseConfig({ token: TOKEN, repos: ['acme/site', 'acme/api'], ...config });
    const api = createGitHubApi({
      token: cfg.token,
      apiBase: cfg.api_base,
      timeoutMs: cfg.timeout,
      fetch: (url, init) => this.handle(url, init),
    });
    return new GitHubOps(api, cfg);
  }

  private handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    };
    this.calls.push(call);
    const route = this.routes.get(`${call.method} ${call.path}`);
    if (route === undefined) {
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }));
    }
    const r = route(call);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return Promise.resolve(
      new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} }),
    );
  }
}

function pull(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${String(number)}`,
    state: 'open',
    draft: false,
    html_url: `https://github.com/acme/site/pull/${String(number)}`,
    user: { login: 'miro' },
    labels: [{ name: 'content' }],
    head: { ref: 'feature', sha: 'abc', repo: { full_name: 'acme/site' } },
    base: { ref: 'main', sha: 'def' },
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    closed_at: null,
    merged_at: null,
    body: 'the body',
    ...extra,
  };
}

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${String(number)}`,
    state: 'open',
    html_url: `https://github.com/acme/site/issues/${String(number)}`,
    user: { login: 'miro' },
    labels: [{ name: 'bug' }],
    assignees: [],
    comments: 0,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    closed_at: null,
    ...extra,
  };
}

describe('config', () => {
  it('needs a token and at least one repository', () => {
    expect(() => parseConfig({ token: TOKEN, repos: [] })).toThrow(/at least one repository/);
    expect(() => parseConfig({ token: '', repos: ['a/b'] })).toThrow(/token is empty/);
    expect(() => parseConfig({ token: TOKEN, repos: ['nope'] })).toThrow(/owner\/name/);
    expect(parseConfig({ token: TOKEN, repos: ['Acme/Site'] }).repos).toEqual(['acme/site']);
  });
});

describe('repository scope', () => {
  it('defaults to the first repo and accepts owner+repo or owner/name', () => {
    const ops = new FakeGitHub().ops();
    expect(ops.resolveRepo({})).toBe('acme/site');
    expect(ops.resolveRepo({ owner: 'acme', repo: 'api' })).toBe('acme/api');
    expect(ops.resolveRepo({ repo: 'ACME/api' })).toBe('acme/api');
  });

  it('refuses any other repository before calling GitHub', async () => {
    const gh = new FakeGitHub();
    const ops = gh.ops();
    await expect(ops.listPullRequests({ owner: 'evil', repo: 'x' })).rejects.toThrow(
      /not in the connector's repos/,
    );
    expect(() => ops.resolveRepo({ owner: 'acme' })).toThrow(/name the repository/);
    expect(() => ops.resolveRepo({ owner: 'evil', repo: 'acme/site' })).toThrow(/does not belong/);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('ops', () => {
  it('lists pull requests in the poller shape, with auth headers', async () => {
    const gh = new FakeGitHub().on('GET /repos/acme/site/pulls', () => ({
      body: [pull(7), pull(8, { draft: true })],
    }));
    const result = await gh.ops().listPullRequests({ owner: 'acme', repo: 'site', state: 'open' });
    expect(result.repo).toBe('acme/site');
    expect(result.pull_requests).toEqual([
      {
        number: 7,
        title: 'PR 7',
        state: 'open',
        draft: false,
        url: 'https://github.com/acme/site/pull/7',
        user: 'miro',
        labels: ['content'],
        head: { ref: 'feature', sha: 'abc', repo: 'acme/site' },
        base: { ref: 'main', sha: 'def' },
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-02T00:00:00Z',
        closed_at: null,
        merged_at: null,
      },
      expect.objectContaining({ number: 8, draft: true }),
    ]);
    const [call] = gh.calls;
    expect(call?.query).toEqual({ state: 'open', per_page: '30', page: '1' });
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('pages until the limit and drops pull requests from issues', async () => {
    const gh = new FakeGitHub().on('GET /repos/acme/site/issues', (c) => {
      const page = Number(c.query.page);
      const items = Array.from({ length: page === 1 ? 100 : 20 }, (_, i) =>
        issue(page * 1000 + i, i % 2 === 0 ? { pull_request: {} } : {}),
      );
      return { body: items };
    });
    const result = await gh.ops().listIssues({ limit: 60, labels: ['bug', 'p1'] });
    expect((result.issues as unknown[]).length).toBe(60);
    expect(gh.calls.map((c) => c.query.page)).toEqual(['1', '2']);
    expect(gh.calls[0]?.query).toMatchObject({ per_page: '100', labels: 'bug,p1', state: 'open' });
  });

  it('gets a pull request with its body and a clipped diff', async () => {
    const gh = new FakeGitHub().on('GET /repos/acme/site/pulls/7', (c) =>
      c.headers.accept === 'application/vnd.github.diff'
        ? { body: 'diff --git a/x b/x\n+hello world' }
        : {
            body: pull(7, {
              merged: false,
              mergeable: true,
              additions: 3,
              requested_reviewers: [{ login: 'bob' }],
            }),
          },
    );
    const ops = gh.ops({ max_text: 10 });
    const pr = await ops.getPullRequest({ number: 7 });
    expect(pr).toMatchObject({
      number: 7,
      body: 'the body',
      mergeable: true,
      additions: 3,
      requested_reviewers: ['bob'],
    });
    const diff = await ops.getPullRequestDiff({ number: 7 });
    expect(diff).toEqual({ repo: 'acme/site', number: 7, diff: 'diff --git', truncated: true });
  });

  it('scopes search to the repository and refuses repo qualifiers', async () => {
    const gh = new FakeGitHub().on('GET /search/issues', () => ({
      body: { total_count: 1, items: [issue(3, { pull_request: {} })] },
    }));
    const ops = gh.ops();
    const result = await ops.searchIssues({ repo: 'acme/api', query: 'is:pr label:deploy' });
    expect(gh.calls[0]?.query.q).toBe('is:pr label:deploy repo:acme/api');
    expect(result.issues).toEqual([expect.objectContaining({ number: 3, is_pull_request: true })]);
    await expect(ops.searchIssues({ query: 'repo:evil/x bug' })).rejects.toThrow(/must not name/);
  });

  it('lists workflow runs of one workflow', async () => {
    const gh = new FakeGitHub().on('GET /repos/acme/site/actions/workflows/ci.yml/runs', () => ({
      body: {
        total_count: 1,
        workflow_runs: [
          {
            id: 1,
            name: 'CI',
            html_url: 'u',
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            head_sha: 'abc',
            run_number: 12,
            created_at: 't',
            updated_at: 't',
          },
        ],
      },
    }));
    const result = await gh.ops().listWorkflowRuns({ workflow: 'ci.yml', branch: 'main' });
    expect(result.workflow_runs).toEqual([
      expect.objectContaining({ id: 1, conclusion: 'failure', run_attempt: 1, branch: 'main' }),
    ]);
  });

  it('writes: issue, comment, labels, pull request', async () => {
    const gh = new FakeGitHub()
      .on('POST /repos/acme/site/issues', () => ({ status: 201, body: issue(11) }))
      .on('PATCH /repos/acme/site/issues/11', (c) => ({
        body: issue(11, c.body as Record<string, unknown>),
      }))
      .on('POST /repos/acme/site/issues/11/comments', () => ({
        status: 201,
        body: { id: 99, html_url: 'c', user: null, created_at: 't', updated_at: 't' },
      }))
      .on('POST /repos/acme/site/issues/11/labels', () => ({
        body: [{ name: 'bug' }, { name: 'p1' }],
      }))
      .on('DELETE /repos/acme/site/issues/11/labels/p%201', () => ({ body: [{ name: 'bug' }] }))
      .on('POST /repos/acme/site/pulls', () => ({ status: 201, body: pull(12) }));
    const ops = gh.ops();
    expect(await ops.createIssue({ title: 'T', labels: ['bug'] })).toEqual({
      repo: 'acme/site',
      number: 11,
      url: 'https://github.com/acme/site/issues/11',
    });
    expect(gh.calls[0]?.body).toEqual({ title: 'T', labels: ['bug'] });
    expect(await ops.updateIssue({ number: 11, state: 'closed' })).toMatchObject({
      state: 'closed',
    });
    expect(gh.calls[1]?.body).toEqual({ state: 'closed' });
    expect(await ops.addComment({ number: 11, body: 'hi' })).toEqual({
      repo: 'acme/site',
      id: 99,
      url: 'c',
    });
    expect((await ops.addLabels({ number: 11, labels: ['p1'] })).labels).toEqual(['bug', 'p1']);
    expect((await ops.removeLabel({ number: 11, label: 'p 1' })).labels).toEqual(['bug']);
    expect(await ops.createPullRequest({ title: 'x', head: 'f', base: 'main' })).toMatchObject({
      number: 12,
    });
  });

  it('reports GitHub errors with the message and rate-limit reset, never the token', async () => {
    const gh = new FakeGitHub()
      .on('GET /repos/acme/site/pulls', () => ({
        status: 403,
        body: { message: `API rate limit exceeded for ${TOKEN}` },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
      }))
      .on('POST /repos/acme/site/issues', () => ({
        status: 422,
        body: { message: 'Validation Failed', errors: [{ message: 'title is too long' }] },
      }));
    const ops = gh.ops();
    const err = await ops.listPullRequests({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(403);
    expect((err as Error).message).toContain('rate limited until 2026-');
    expect((err as Error).message).not.toContain(TOKEN);
    await expect(ops.createIssue({ title: 'x' })).rejects.toThrow(
      'POST /repos/acme/site/issues: Validation Failed: title is too long (422)',
    );
  });
});
