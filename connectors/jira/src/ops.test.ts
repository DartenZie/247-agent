import { describe, expect, it } from 'vitest';

import { adfToText, textToAdf } from './adf.js';
import { createJiraApi, JiraError } from './api.js';
import { authorization, parseConfig } from './config.js';
import { JiraOps, splitOrderBy } from './ops.js';

const API_TOKEN = 'atl-secret-token';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

type Route = (call: Call) => { status?: number; body?: unknown };

/** A fake Jira behind the injected fetch: routes by "METHOD /rest/api/N/path". */
class FakeJira {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Route>();

  on(key: string, route: Route): this {
    this.routes.set(key, route);
    return this;
  }

  ops(config: Record<string, unknown> = {}): JiraOps {
    const cfg = parseConfig({
      base_url: 'https://acme.atlassian.net',
      email: 'bot@acme.test',
      api_token: API_TOKEN,
      projects: ['SITE', 'OPS'],
      ...config,
    });
    return new JiraOps(
      createJiraApi(cfg, (url, init) => this.handle(url, init)),
      cfg,
    );
  }

  private handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: init.headers as Record<string, string>,
    };
    this.calls.push(call);
    const route = this.routes.get(`${call.method} ${call.path}`);
    if (route === undefined) {
      return Promise.resolve(
        Response.json({ errorMessages: ['Issue does not exist'] }, { status: 404 }),
      );
    }
    const r = route(call);
    return Promise.resolve(
      r.body === undefined
        ? new Response(null, { status: r.status ?? 204 })
        : Response.json(r.body, { status: r.status ?? 200 }),
    );
  }
}

function issue(key: string, extra: Record<string, unknown> = {}) {
  return {
    id: '100',
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      labels: ['web'],
      assignee: { displayName: 'Miro P' },
      reporter: null,
      created: '2026-09-01T10:00:00.000+0000',
      updated: '2026-09-02T10:00:00.000+0000',
      project: { key: key.split('-')[0] },
      ...extra,
    },
  };
}

describe('config', () => {
  it('needs exactly one auth scheme and at least one project', () => {
    const base = { base_url: 'https://jira.acme.test', projects: ['SITE'] };
    expect(() => parseConfig(base)).toThrow(/exactly one of/);
    expect(() => parseConfig({ ...base, token: 'pat', email: 'a', api_token: 'b' })).toThrow(
      /exactly one/,
    );
    expect(() => parseConfig({ ...base, email: 'a' })).toThrow(/go together/);
    expect(() => parseConfig({ ...base, token: 'pat', projects: [] })).toThrow(
      /at least one project/,
    );
    expect(() => parseConfig({ ...base, token: 'pat', projects: ['site'] })).toThrow(/project key/);
  });

  it('infers the deployment and builds the Authorization header', () => {
    const dc = parseConfig({
      base_url: 'https://jira.acme.test/',
      token: 'pat',
      projects: ['SITE'],
    });
    expect(dc.deployment).toBe('datacenter');
    expect(dc.base_url).toBe('https://jira.acme.test');
    expect(authorization(dc)).toBe('Bearer pat');
    const cloud = parseConfig({
      base_url: 'https://acme.atlassian.net',
      email: 'a@b',
      api_token: 't',
      projects: ['SITE'],
    });
    expect(cloud.deployment).toBe('cloud');
    expect(authorization(cloud)).toBe(`Basic ${Buffer.from('a@b:t').toString('base64')}`);
  });
});

describe('JQL scope', () => {
  const ops = new FakeJira().ops();

  it('wraps the query and keeps ORDER BY last', () => {
    expect(ops.scopeJql('status = "To Do" ORDER BY created DESC')).toBe(
      'project in (SITE, OPS) AND (status = "To Do") ORDER BY created DESC',
    );
    expect(ops.scopeJql('')).toBe('project in (SITE, OPS)');
    expect(ops.scopeJql('order by updated')).toBe('project in (SITE, OPS) order by updated');
    expect(ops.scopeJql('summary ~ "order by x"')).toBe(
      'project in (SITE, OPS) AND (summary ~ "order by x")',
    );
  });

  it('refuses a query that would close the scope', () => {
    expect(() => ops.scopeJql('x = 1) OR (project = SECRET')).toThrow(/unmatched "\)"/);
    expect(() => ops.scopeJql('(x = 1')).toThrow(/unmatched "\("/);
    expect(() => ops.scopeJql('summary ~ "open')).toThrow(/unterminated/);
    expect(splitOrderBy('a = ")" ORDER BY b')).toEqual({
      where: 'a = ")" ',
      orderBy: 'ORDER BY b',
    });
  });

  it('checks issue keys against the projects', () => {
    expect(ops.checkKey('site-12')).toBe('SITE-12');
    expect(() => ops.checkKey('HR-1')).toThrow(/not in the connector's projects/);
    expect(() => ops.checkKey('nope')).toThrow(/not an issue key/);
  });
});

describe('ops on Cloud', () => {
  it('searches with /search/jql, pages by token and drops out-of-scope issues', async () => {
    const jira = new FakeJira().on('POST /rest/api/3/search/jql', (c) =>
      c.body?.nextPageToken === undefined
        ? { body: { issues: [issue('SITE-1'), issue('HR-9')], nextPageToken: 'p2' } }
        : { body: { issues: [issue('OPS-2', { customfield_1: 5 })], isLast: true } },
    );
    const result = await jira.ops().search({ jql: 'status = "To Do"', fields: ['customfield_1'] });
    expect(result.jql).toBe('project in (SITE, OPS) AND (status = "To Do")');
    expect(result.issues).toEqual([
      {
        key: 'SITE-1',
        id: '100',
        url: 'https://acme.atlassian.net/browse/SITE-1',
        project: 'SITE',
        summary: 'Summary of SITE-1',
        status: 'To Do',
        status_category: 'new',
        issue_type: 'Task',
        priority: 'Medium',
        labels: ['web'],
        assignee: 'Miro P',
        reporter: null,
        created: '2026-09-01T10:00:00.000+0000',
        updated: '2026-09-02T10:00:00.000+0000',
        fields: { customfield_1: null },
      },
      expect.objectContaining({ key: 'OPS-2', fields: { customfield_1: 5 } }),
    ]);
    expect(jira.calls[0]?.body).toMatchObject({ maxResults: 50 });
    expect(jira.calls[0]?.body?.fields).toEqual(
      expect.arrayContaining(['summary', 'customfield_1']),
    );
    expect(jira.calls[1]?.body).toMatchObject({ nextPageToken: 'p2' });
    expect(jira.calls[0]?.headers.authorization).toMatch(/^Basic /);
  });

  it('reads the description and comments as plain text', async () => {
    const jira = new FakeJira()
      .on('GET /rest/api/3/issue/SITE-1', () => ({
        body: issue('SITE-1', {
          description: textToAdf('First line\nsecond line\n\nNext paragraph'),
        }),
      }))
      .on('GET /rest/api/3/issue/SITE-1/comment', () => ({
        body: {
          total: 2,
          comments: [
            {
              id: '2',
              author: { displayName: 'B' },
              body: textToAdf('newer'),
              created: '2026-09-03',
              updated: '2026-09-03',
            },
            {
              id: '1',
              author: { displayName: 'A' },
              body: textToAdf('older'),
              created: '2026-09-02',
              updated: '2026-09-02',
            },
          ],
        },
      }));
    const result = await jira.ops().getIssue({ key: 'SITE-1', comments: 5 });
    expect(result.description).toBe('First line\nsecond line\n\nNext paragraph');
    expect(result.comments).toEqual([
      { id: '1', author: 'A', body: 'older', created: '2026-09-02', updated: '2026-09-02' },
      { id: '2', author: 'B', body: 'newer', created: '2026-09-03', updated: '2026-09-03' },
    ]);
  });

  it('refuses an issue that moved out of the projects', async () => {
    const jira = new FakeJira().on('GET /rest/api/3/issue/SITE-1', () => ({
      body: issue('HR-4'),
    }));
    await expect(jira.ops().getIssue({ key: 'SITE-1' })).rejects.toThrow(/now lives in project HR/);
  });

  it('creates, updates and comments with ADF bodies', async () => {
    const jira = new FakeJira()
      .on('POST /rest/api/3/issue', () => ({ status: 201, body: { id: '7', key: 'SITE-7' } }))
      .on('PUT /rest/api/3/issue/SITE-7', () => ({}))
      .on('POST /rest/api/3/issue/SITE-7/comment', () => ({
        status: 201,
        body: { id: '55', created: 't', updated: 't' },
      }));
    const ops = jira.ops();
    expect(
      await ops.createIssue({ summary: 'Fix it', description: 'Line', labels: ['bot'] }),
    ).toEqual({
      key: 'SITE-7',
      id: '7',
      url: 'https://acme.atlassian.net/browse/SITE-7',
    });
    expect(jira.calls[0]?.body).toEqual({
      fields: {
        project: { key: 'SITE' },
        issuetype: { name: 'Task' },
        summary: 'Fix it',
        description: textToAdf('Line'),
        labels: ['bot'],
      },
    });
    await expect(ops.createIssue({ project: 'HR', summary: 'x' })).rejects.toThrow(
      /not in the connector's projects/,
    );
    expect(await ops.updateIssue({ key: 'SITE-7', priority: 'High' })).toEqual({
      key: 'SITE-7',
      updated: ['priority'],
    });
    await expect(
      ops.updateIssue({ key: 'SITE-7', fields: { project: { key: 'HR' } } }),
    ).rejects.toThrow(/another project/);
    await expect(ops.updateIssue({ key: 'SITE-7' })).rejects.toThrow(/nothing to update/);
    expect(await ops.addComment({ key: 'SITE-7', body: 'Done' })).toEqual({
      key: 'SITE-7',
      id: '55',
      url: 'https://acme.atlassian.net/browse/SITE-7?focusedCommentId=55',
    });
  });

  it('transitions by name, id or target status, with a comment', async () => {
    const jira = new FakeJira()
      .on('GET /rest/api/3/issue/SITE-1/transitions', () => ({
        body: {
          transitions: [
            { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
            { id: '31', name: 'Resolve', to: { name: 'Done' } },
          ],
        },
      }))
      .on('POST /rest/api/3/issue/SITE-1/transitions', () => ({}));
    const ops = jira.ops();
    expect(
      await ops.transitionIssue({ key: 'SITE-1', transition: 'done', comment: 'Shipped' }),
    ).toEqual({
      key: 'SITE-1',
      transition: 'Resolve',
      status: 'Done',
    });
    expect(jira.calls[1]?.body).toEqual({
      transition: { id: '31' },
      update: { comment: [{ add: { body: textToAdf('Shipped') } }] },
    });
    expect((await ops.transitionIssue({ key: 'SITE-1', transition: '11' })).status).toBe(
      'In Progress',
    );
    await expect(ops.transitionIssue({ key: 'SITE-1', transition: 'Reopen' })).rejects.toThrow(
      /available: Start progress, Resolve/,
    );
  });

  it('reports Jira errors without the credentials', async () => {
    const jira = new FakeJira().on('POST /rest/api/3/issue', () => ({
      status: 400,
      body: { errorMessages: [], errors: { summary: `bad ${API_TOKEN}` } },
    }));
    const err = await jira
      .ops()
      .createIssue({ summary: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as Error).message).toBe('POST /issue: summary: bad <credential> (400)');
  });
});

describe('ops on Data Center', () => {
  it('uses API v2, startAt paging and plain-text bodies', async () => {
    const jira = new FakeJira()
      .on('POST /rest/api/2/search', (c) => ({
        body: {
          total: 3,
          issues: c.body?.startAt === 0 ? [issue('SITE-1'), issue('SITE-2')] : [issue('SITE-3')],
        },
      }))
      .on('POST /rest/api/2/issue/SITE-1/comment', () => ({
        status: 201,
        body: { id: '9', created: 't', updated: 't' },
      }));
    const ops = jira.ops({
      base_url: 'https://jira.acme.test',
      email: undefined,
      api_token: undefined,
      token: 'pat',
    });
    const result = await ops.search({ jql: '', limit: 3 });
    expect((result.issues as unknown[]).length).toBe(3);
    expect(jira.calls.map((c) => c.body?.startAt)).toEqual([0, 2]);
    await ops.addComment({ key: 'SITE-1', body: 'plain' });
    expect(jira.calls[2]?.body).toEqual({ body: 'plain' });
    expect(jira.calls[2]?.headers.authorization).toBe('Bearer pat');
  });
});

describe('ADF', () => {
  it('renders lists, mentions, links and code', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'mention', attrs: { text: '@Miro' } },
                    { type: 'text', text: ' see ' },
                    { type: 'inlineCard', attrs: { url: 'https://x.test' } },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
      ],
    };
    expect(adfToText(doc)).toBe('Title\n\n- one\n- @Miro see https://x.test\n\nnpm test');
    expect(adfToText(null)).toBe('');
    expect(adfToText('wiki *markup*')).toBe('wiki *markup*');
  });

  it('round-trips plain text', () => {
    const text = 'a\nb\n\nc';
    expect(adfToText(textToAdf(text))).toBe(text);
    expect(textToAdf('')).toEqual({ type: 'doc', attrs: { version: 1 }, content: [] });
  });
});
