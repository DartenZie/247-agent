/**
 * The ops, over the REST client. Every issue key and every JQL query is confined to the
 * configured `projects`: keys are checked by prefix (and the fetched issue's project), a
 * query becomes `project in (…) AND (<query>)`. Rich text is plain text in and out; on
 * Cloud it is converted from and to ADF. List ops wrap their array in an object
 * (`{issues: […]}`) so the built-in poller's `items` has a name to point at.
 */
import type { JsonValue } from '@247-agent/connector-sdk';

import { adfToText, textToAdf } from './adf.js';
import type { JiraApi } from './api.js';
import type { JiraConfig } from './config.js';

type Json = Record<string, JsonValue>;

/** Fields every issue summary reads. */
const SUMMARY_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'labels',
  'assignee',
  'reporter',
  'created',
  'updated',
  'project',
];

interface JiraUser {
  displayName?: string;
  accountId?: string;
  name?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    labels?: string[];
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    created?: string;
    updated?: string;
    project?: { key?: string } | null;
    description?: unknown;
  };
}

interface JiraComment {
  id: string;
  author?: JiraUser | null;
  body?: unknown;
  created: string;
  updated: string;
}

interface Transition {
  id: string;
  name: string;
  to?: { name?: string } | null;
}

export class JiraOps {
  constructor(
    private readonly api: JiraApi,
    private readonly config: JiraConfig,
  ) {}

  /** Throws unless `key` looks like `PROJ-123` with `PROJ` in `projects`. */
  checkKey(key: string): string {
    const match = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(key.trim().toUpperCase());
    if (match?.[1] === undefined) {
      throw new Error(`"${key}" is not an issue key like SITE-12`);
    }
    if (!this.config.projects.includes(match[1])) {
      throw new Error(`project ${match[1]} is not in the connector's projects`);
    }
    return match[0];
  }

  /** The query confined to the configured projects, `ORDER BY` kept at the end. */
  scopeJql(jql: string): string {
    const scope = `project in (${this.config.projects.join(', ')})`;
    const { where, orderBy } = splitOrderBy(jql);
    const clause = where.trim() === '' ? scope : `${scope} AND (${where.trim()})`;
    return orderBy === '' ? clause : `${clause} ${orderBy}`;
  }

  async search(args: {
    jql: string;
    fields?: string[] | undefined;
    limit?: number | undefined;
  }): Promise<Json> {
    const jql = this.scopeJql(args.jql);
    const want = Math.max(1, Math.min(args.limit ?? 50, 1000));
    const fields = [...new Set([...SUMMARY_FIELDS, ...(args.fields ?? [])])];
    const issues: JiraIssue[] = [];
    if (this.config.deployment === 'cloud') {
      let token: string | undefined;
      do {
        const page = await this.api.request<{ issues?: JiraIssue[]; nextPageToken?: string }>(
          'POST',
          '/search/jql',
          {
            body: {
              jql,
              fields,
              maxResults: Math.min(100, want - issues.length),
              ...(token === undefined ? {} : { nextPageToken: token }),
            },
          },
        );
        issues.push(...(page.issues ?? []));
        token = page.nextPageToken;
      } while (token !== undefined && issues.length < want);
    } else {
      for (;;) {
        const page = await this.api.request<{ issues?: JiraIssue[]; total?: number }>(
          'POST',
          '/search',
          {
            body: {
              jql,
              fields,
              startAt: issues.length,
              maxResults: Math.min(100, want - issues.length),
            },
          },
        );
        const got = page.issues ?? [];
        issues.push(...got);
        if (got.length === 0 || issues.length >= want || issues.length >= (page.total ?? 0)) {
          break;
        }
      }
    }
    // Belt and braces: the query is scoped, but never hand out an issue from elsewhere.
    const inScope = issues.filter((i) =>
      this.config.projects.includes(i.fields.project?.key ?? i.key.split('-')[0] ?? ''),
    );
    return { jql, issues: inScope.slice(0, want).map((i) => this.summary(i, args.fields)) };
  }

  async getIssue(args: {
    key: string;
    fields?: string[] | undefined;
    comments?: number | undefined;
  }): Promise<Json> {
    const key = this.checkKey(args.key);
    const fields = [...new Set([...SUMMARY_FIELDS, 'description', ...(args.fields ?? [])])];
    const issue = await this.api.request<JiraIssue>('GET', `/issue/${key}`, {
      query: { fields: fields.join(',') },
    });
    const project = issue.fields.project?.key;
    if (project !== undefined && !this.config.projects.includes(project)) {
      throw new Error(
        `${key} now lives in project ${project}, which is not in the connector's projects`,
      );
    }
    const result: Json = {
      ...this.summary(issue, args.fields),
      description: this.clip(adfToText(issue.fields.description)),
    };
    if ((args.comments ?? 0) > 0) {
      result.comments = (await this.listComments({ key, limit: args.comments })).comments ?? [];
    }
    return result;
  }

  /** Newest comments last; `limit` takes the most recent ones. */
  async listComments(args: { key: string; limit?: number | undefined }): Promise<Json> {
    const key = this.checkKey(args.key);
    const want = Math.max(1, Math.min(args.limit ?? 20, 100));
    const page = await this.api.request<{ comments?: JiraComment[]; total?: number }>(
      'GET',
      `/issue/${key}/comment`,
      { query: { orderBy: '-created', maxResults: want } },
    );
    const comments = (page.comments ?? [])
      .slice(0, want)
      .sort((a, b) => a.created.localeCompare(b.created))
      .map((c) => ({
        id: c.id,
        author: userName(c.author),
        body: this.clip(adfToText(c.body)),
        created: c.created,
        updated: c.updated,
      }));
    return { key, total: page.total ?? comments.length, comments };
  }

  async createIssue(args: {
    project?: string | undefined;
    issue_type?: string | undefined;
    summary: string;
    description?: string | undefined;
    labels?: string[] | undefined;
    priority?: string | undefined;
    fields?: Record<string, unknown> | undefined;
  }): Promise<Json> {
    const project = args.project?.toUpperCase() ?? this.config.projects[0] ?? '';
    if (!this.config.projects.includes(project)) {
      throw new Error(`project ${project} is not in the connector's projects`);
    }
    const created = await this.api.request<{ id: string; key: string }>('POST', '/issue', {
      body: {
        fields: {
          ...(args.fields ?? {}),
          project: { key: project },
          issuetype: { name: args.issue_type ?? 'Task' },
          summary: args.summary,
          ...(args.description === undefined
            ? {}
            : { description: this.richText(args.description) }),
          ...(args.labels === undefined ? {} : { labels: args.labels }),
          ...(args.priority === undefined ? {} : { priority: { name: args.priority } }),
        },
      },
    });
    return { key: created.key, id: created.id, url: this.browse(created.key) };
  }

  async updateIssue(args: {
    key: string;
    summary?: string | undefined;
    description?: string | undefined;
    labels?: string[] | undefined;
    priority?: string | undefined;
    fields?: Record<string, unknown> | undefined;
  }): Promise<Json> {
    const key = this.checkKey(args.key);
    const fields: Record<string, unknown> = { ...(args.fields ?? {}) };
    if (args.summary !== undefined) {
      fields.summary = args.summary;
    }
    if (args.description !== undefined) {
      fields.description = this.richText(args.description);
    }
    if (args.labels !== undefined) {
      fields.labels = args.labels;
    }
    if (args.priority !== undefined) {
      fields.priority = { name: args.priority };
    }
    if (Object.keys(fields).length === 0) {
      throw new Error('nothing to update');
    }
    if ('project' in fields) {
      throw new Error('moving an issue to another project is not supported');
    }
    await this.api.request('PUT', `/issue/${key}`, { body: { fields } });
    return { key, updated: Object.keys(fields) };
  }

  async addComment(args: { key: string; body: string }): Promise<Json> {
    const key = this.checkKey(args.key);
    const c = await this.api.request<JiraComment>('POST', `/issue/${key}/comment`, {
      body: { body: this.richText(args.body) },
    });
    return { key, id: c.id, url: `${this.browse(key)}?focusedCommentId=${c.id}` };
  }

  async listTransitions(args: { key: string }): Promise<Json> {
    const key = this.checkKey(args.key);
    return {
      key,
      transitions: (await this.transitions(key)).map((t) => ({
        id: t.id,
        name: t.name,
        to: t.to?.name ?? null,
      })),
    };
  }

  /** Moves the issue through the transition named (case-insensitive) or with that id. */
  async transitionIssue(args: {
    key: string;
    transition: string;
    comment?: string | undefined;
    fields?: Record<string, unknown> | undefined;
  }): Promise<Json> {
    const key = this.checkKey(args.key);
    const available = await this.transitions(key);
    const wanted = args.transition.trim().toLowerCase();
    const t =
      available.find((x) => x.id === args.transition.trim()) ??
      available.find((x) => x.name.toLowerCase() === wanted) ??
      available.find((x) => x.to?.name?.toLowerCase() === wanted);
    if (t === undefined) {
      throw new Error(
        `${key} has no transition "${args.transition}"; available: ${available.map((x) => x.name).join(', ') || 'none'}`,
      );
    }
    await this.api.request('POST', `/issue/${key}/transitions`, {
      body: {
        transition: { id: t.id },
        ...(args.fields === undefined ? {} : { fields: args.fields }),
        ...(args.comment === undefined
          ? {}
          : { update: { comment: [{ add: { body: this.richText(args.comment) } }] } }),
      },
    });
    return { key, transition: t.name, status: t.to?.name ?? null };
  }

  private async transitions(key: string): Promise<Transition[]> {
    const r = await this.api.request<{ transitions?: Transition[] }>(
      'GET',
      `/issue/${key}/transitions`,
    );
    return r.transitions ?? [];
  }

  private summary(i: JiraIssue, extra: string[] | undefined): Json {
    const f = i.fields;
    const out: Json = {
      key: i.key,
      id: i.id,
      url: this.browse(i.key),
      project: f.project?.key ?? i.key.split('-')[0] ?? null,
      summary: f.summary ?? '',
      status: f.status?.name ?? null,
      status_category: f.status?.statusCategory?.key ?? null,
      issue_type: f.issuetype?.name ?? null,
      priority: f.priority?.name ?? null,
      labels: f.labels ?? [],
      assignee: userName(f.assignee),
      reporter: userName(f.reporter),
      created: f.created ?? null,
      updated: f.updated ?? null,
    };
    if (extra !== undefined && extra.length > 0) {
      out.fields = Object.fromEntries(extra.map((k) => [k, (f[k] ?? null) as JsonValue]));
    }
    return out;
  }

  private richText(text: string): unknown {
    return this.config.deployment === 'cloud' ? textToAdf(text) : text;
  }

  private browse(key: string): string {
    return `${this.config.base_url}/browse/${key}`;
  }

  private clip(text: string): string {
    return text.length > this.config.max_text ? text.slice(0, this.config.max_text) : text;
  }
}

function userName(u: JiraUser | null | undefined): string | null {
  return u?.displayName ?? u?.name ?? null;
}

/**
 * Splits a trailing `ORDER BY …` off a query, ignoring the words inside quotes. Throws when
 * the parentheses outside quotes do not balance: `x) OR (project = OTHER` would otherwise
 * close the project scope it is wrapped in.
 */
export function splitOrderBy(jql: string): { where: string; orderBy: string } {
  let quote: string | null = null;
  let depth = 0;
  let at = -1;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth < 0) {
        throw new Error('the query has an unmatched ")"');
      }
    } else if (
      depth === 0 &&
      /^order\s+by\b/i.test(jql.slice(i)) &&
      (i === 0 || /[\s)]/.test(jql[i - 1] ?? ''))
    ) {
      at = i;
    }
  }
  if (quote !== null) {
    throw new Error('the query has an unterminated string');
  }
  if (depth !== 0) {
    throw new Error('the query has an unmatched "("');
  }
  return at < 0
    ? { where: jql, orderBy: '' }
    : { where: jql.slice(0, at), orderBy: jql.slice(at).trim() };
}
