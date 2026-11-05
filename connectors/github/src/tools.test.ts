import { readFileSync } from 'node:fs';

import { listTools } from '@247-agent/connector-sdk/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { GitHubOps } from './ops.js';
import { githubTools } from './tools.js';

const example = parse(
  readFileSync(new URL('../../../docs/examples/connectors.d/github.yaml', import.meta.url), 'utf8'),
) as { ops: string[] };

/** Ops the example manifest does not allow on purpose: an operator adds them. */
const notInExample = ['create_issue', 'update_issue', 'remove_label', 'create_pull_request'];

describe('github tool registrations', () => {
  it('lists the example manifest ops over MCP, plus the ones it leaves out', async () => {
    const tools = await listTools(githubTools({} as GitHubOps));
    expect(tools.map((t) => t.name).sort()).toEqual([...example.ops, ...notInExample].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });
});
