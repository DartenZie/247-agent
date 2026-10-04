#!/usr/bin/env node
// Prints the verification rungs a change needs, from the files it touches.
//
//   node .claude/skills/verify/scripts/plan.mjs [--base <ref>] [--json] [files...]
//
// Without files it reads the change from git: committed since the merge base with --base
// (default: origin/main, else main), plus staged, unstaged and untracked files. Paths are
// repo-relative. Exit 0 always; the plan is advice, the rungs decide.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const baseIdx = args.indexOf('--base');
const base = baseIdx >= 0 ? args[baseIdx + 1] : undefined;
const explicit = args.filter((a, i) => !a.startsWith('--') && (baseIdx < 0 || i !== baseIdx + 1));

const git = (...a) => {
  try {
    return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const root = git('rev-parse', '--show-toplevel') || process.cwd();

function changedFiles() {
  if (explicit.length) return explicit;
  const ref = base ?? (git('rev-parse', '--verify', '-q', 'origin/main') ? 'origin/main' : 'main');
  const mb = git('merge-base', ref, 'HEAD');
  const lists = [
    mb ? git('diff', '--name-only', mb, 'HEAD') : '',
    git('diff', '--name-only', '--cached'),
    git('diff', '--name-only'),
    git('ls-files', '--others', '--exclude-standard'),
  ];
  return [...new Set(lists.join('\n').split('\n').filter(Boolean))];
}

const files = changedFiles();
// Docs alone never need more than the baseline.
const has = (re) => files.filter((f) => re.test(f) && !f.endsWith('.md'));

// Connectors that have a smoke rig: connectors/<name>/test/smoke/smoke.mjs.
const smokeConnectors = ['chat', 'email', 'ftp', 'github', 'jira', 'webhook'].filter((n) =>
  existsSync(join(root, 'connectors', n, 'test', 'smoke', 'smoke.mjs')),
);

const rungs = [];
const add = (id, command, why, hits) => {
  if (hits.length) rungs.push({ id, command, why, files: hits });
};

const code = has(/\.(ts|mjs|js|json|ya?ml|sh)$/);
add(
  'baseline',
  'npm run build && npm run lint && npm test && node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml',
  'every change',
  files,
);

add(
  'daemon',
  'a real daemon on a scratch config: oa run / oa emit, then oa runs show and the log (247-agent-operate skill)',
  'runtime behaviour the unit tests mock: core wiring, API, CLI, config loading, examples',
  has(
    /^packages\/(core\/src\/(core|daemon|main|retention|metrics|log)\.ts|core\/src\/(api|bus|executor|scheduler|store|config|expr|secrets)\/|cli\/src\/)|^docs\/examples\/|^packaging\/etc\//,
  ).filter((f) => !/\.test\.ts$/.test(f)),
);

add(
  'linux',
  'npm run test:linux',
  'needs real bubblewrap, Linux namespaces, file modes or the Linux socket path limit',
  has(
    /^packages\/core\/src\/(actions\/(sandbox|shell)|connectors\/(net-proxy|supervisor|child-env|host|mcp-bridge|socket-transport)|secrets\/|home)|^packages\/core\/test\/fixtures\/fake-bwrap|^scripts\/linux-test\.sh$/,
  ),
);

add(
  'linux-systemd',
  'npm run test:linux -- --systemd=always',
  'packaging, launchers, units or install paths: installs the .deb under systemd and runs a task',
  has(
    /^(packaging\/|bin\/|scripts\/(build-release|build-package|bundle|install|uninstall)\.|packages\/core\/src\/(home|version)\.ts$|package\.json$)/,
  ),
);

const sharedConnector = has(
  /^packages\/(connector-sdk\/|core\/src\/(connectors\/(supervisor|host|child-env|socket-transport)|actions\/connector)\.ts)|^test\/smoke\/(connectors\/|lib\.mjs$)/,
);
// One run for every connector that needs it: each run starts and stops the servers.
const connectorHits = smokeConnectors
  .map((name) => ({ name, hits: [...has(new RegExp(`^connectors/${name}/`)), ...sharedConnector] }))
  .filter((c) => c.hits.length > 0);
add(
  'connectors',
  `npm run smoke:connectors -- ${connectorHits.map((c) => c.name).join(' ')}`,
  `${connectorHits.map((c) => c.name).join(' and ')} against real servers in podman`,
  [...new Set(connectorHits.flatMap((c) => c.hits))],
);

const acp = has(
  /^packages\/core\/src\/(actions\/(agent|sandbox-net)|connectors\/(acp|mcp-bridge|net-proxy))|^test\/smoke\/(acp\/|lib\.mjs$)|^packages\/core\/test\/fixtures\/fake-acp/,
).filter((f) => !/\.test\.ts$/.test(f));
add(
  'acp:opencode',
  'npm run smoke:acp -- opencode-acp',
  'agent action against a real ACP agent; free models, no login',
  acp,
);
add(
  'acp:claude',
  'npm run smoke:acp -- claude-acp',
  'the production agent: model/effort switching, transcript redaction, cost reporting; runs on the Claude login',
  acp,
);
add(
  'acp:codex',
  'npm run smoke:acp -- codex-acp',
  'only when the codex profile or codex-specific handling changed; needs a ChatGPT login',
  has(/codex/i),
);

add(
  'ci',
  'only with the user\'s go-ahead to push: push the branch (gh pr create --draft when it has no PR), then gh run watch <id> --exit-status for the run whose headSha is HEAD (247-agent-operate skill, "Linux")',
  'the workflow itself changed; only CI proves it',
  has(/^\.github\/workflows\//),
);

// What no rung covers live. These must be reported as "not verified live", with the reason.
const gaps = [];
const gap = (what, hits) => hits.length && gaps.push({ what, files: hits });
gap(
  'live provider calls (llm, decide, batches): unit tests and fakes only, no live-key rig',
  has(/^packages\/core\/src\/(llm\/|actions\/(llm|decide)\.ts)/).filter(
    (f) => !/\.test\.ts$/.test(f),
  ),
);
for (const name of ['chat', 'email', 'ftp', 'github', 'jira', 'webhook'].filter(
  (n) => !smokeConnectors.includes(n),
)) {
  gap(
    `the ${name} connector against its real service: no smoke rig`,
    has(new RegExp(`^connectors/${name}/src/`)),
  );
}
gap(
  'production server (agent-01): only after the user asked for a deploy, via the orchestra-server skill',
  has(/^local\/orchestra-server\//),
);

if (json) {
  console.log(JSON.stringify({ files, rungs, gaps }, null, 2));
} else {
  console.log(`${files.length} changed file(s)${code.length ? '' : ' (no code)'}\n`);
  for (const r of rungs) {
    console.log(
      `[${r.id}] ${r.command}\n    why: ${r.why}\n    because of: ${r.files.slice(0, 4).join(', ')}${r.files.length > 4 ? ` (+${r.files.length - 4})` : ''}\n`,
    );
  }
  if (gaps.length) {
    console.log('Not covered by any rung (report as not verified live, with this reason):');
    for (const g of gaps) console.log(`  - ${g.what}: ${g.files.slice(0, 3).join(', ')}`);
  }
}
