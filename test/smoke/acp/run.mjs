// The ACP smoke run (`npm run smoke:acp -- <agent>`, README.md): builds the daemon config
// for one agent from agents/<agent>.yaml, starts the daemon on it, runs the four tasks of
// tasks.yaml against the real agent, checks what each left behind, scans every run for
// unredacted secrets, prints `oa cost` and stops the daemon. There is no default agent.
// Exits 0 when every check passed, 1 when one failed, 2 when the rig could not start.
// Needs `npm run build`, plus whatever login the agent's profile names.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';

const RIG = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(RIG, '../../..');
const STATE = join(RIG, '.state');
const REPO = join(STATE, 'repo');
const SOCKET = join(STATE, 'core.sock');
const LOG = join(STATE, 'daemon.log');
const CORE = join(ROOT, 'packages/core/dist/main.js');
const OA = join(ROOT, 'packages/cli/dist/main.js');
const SDK = join(ROOT, 'packages/connector-sdk/dist/index.js');
/** First start downloads the pinned adapter through npx. */
const STARTUP_MS = 180_000;
/** An API key of any provider the agents use, in case one reaches a transcript. */
const KEY = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/;
/** A run that failed on the agent's login; every other run would fail the same way. */
const AUTH_ERROR = /authenticat|oauth|unauthori[sz]ed|not logged in|log ?in|\b401\b/i;

const say = (line) => process.stdout.write(`${line}\n`);
const die = (msg) => {
  process.stderr.write(`smoke:acp: ${msg}\n`);
  process.exit(2);
};
const readYaml = (file) => parse(readFileSync(file, 'utf8'));
const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * `oa <args>` against the rig's socket; returns stdout. Throws on a non-zero exit, except
 * exit 1 with `failedOk`: `run --wait` and `runs show` exit 1 for a failed run but print it.
 */
function oa(args, opts = {}) {
  try {
    return execFileSync(
      process.execPath,
      [OA, ...args, ...(opts.socket === false ? [] : ['--socket', SOCKET])],
      {
        cwd: RIG,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    if (opts.failedOk === true && err.status === 1 && err.stdout) {
      return err.stdout;
    }
    throw new Error(`oa ${args.join(' ')}: ${String(err.stderr ?? '').trim() || err.message}`, {
      cause: err,
    });
  }
}

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The daemon log's JSON lines (non-JSON lines, e.g. a connector's stderr, are skipped). */
function logLines() {
  if (!existsSync(LOG)) {
    return [];
  }
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

// --- arguments and preflight -----------------------------------------------------------

const AGENTS = readdirSync(join(RIG, 'agents'))
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => f.slice(0, -'.yaml'.length))
  .sort();
const USAGE = `usage: npm run smoke:acp -- <agent>\n\nagents: ${AGENTS.join(', ')} (agents/<agent>.yaml)\n`;
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (args.length !== 1 || !AGENTS.includes(args[0])) {
  process.stderr.write(
    `smoke:acp: ${args.length === 0 ? 'name the agent to test' : `unknown agent "${args.join(' ')}"`}\n${USAGE}`,
  );
  process.exit(2);
}
const AGENT = args[0];
const profile = readYaml(join(RIG, 'agents', `${AGENT}.yaml`));

for (const [file, what] of [
  [CORE, 'the daemon'],
  [OA, 'the oa command'],
  [SDK, 'the connector SDK'],
]) {
  if (!existsSync(file)) {
    die(`${what} is not built (${file}); run npm run build first`);
  }
}

// The agent's login: a config dir from the environment or its default, which must exist
// (and hold `requires`, when the profile names one). The agent gets it in its manifest's
// `env`; nothing else of this environment reaches it, so no API key from the shell either.
const login = profile.login ?? {};
let loginDir;
if (login.dir !== undefined) {
  const fromEnv = process.env[login.dir.env];
  loginDir = fromEnv ?? expandHome(login.dir.default);
  const needed = login.requires === undefined ? loginDir : join(loginDir, login.requires);
  if (!existsSync(needed)) {
    die(`no ${AGENT} login at ${needed}: ${login.hint}, or set ${login.dir.env}`);
  }
  say(`smoke:acp: ${AGENT} login from ${loginDir}${fromEnv === undefined ? ' (default)' : ''}`);
} else {
  say(`smoke:acp: ${AGENT} needs no login`);
}

if (existsSync(SOCKET)) {
  let live = false;
  try {
    oa(['connector', 'list']);
    live = true;
  } catch {
    // A stale socket from a killed run: the daemon replaces it.
  }
  if (live) {
    die(`a daemon is already running on ${SOCKET}; stop it first`);
  }
}

// --- the daemon config for this agent --------------------------------------------------

/**
 * .state/<agent>/agent.yaml and tasks.yaml: agent.base.yaml with absolute paths, the probe
 * and the agent as connectors (the agent named after its profile, so `oa cost --by
 * provider` tells agents apart), tasks.yaml with the profile's `tasks:` fields and
 * smoke_override's model and effort filled in, and copies of prompts/ and schemas/ (a
 * task's files must sit under the config's directory). A connector inherits only a
 * minimal environment (`PATH`, `HOME`, …), so what it needs from this run goes into its
 * manifest's `env`: the probe's stamp, the agent's login dir, and `{state}` in the
 * profile's values replaced by the state directory.
 */
function buildConfig(stamp) {
  const dir = join(STATE, AGENT);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ['prompts', 'schemas']) {
    cpSync(join(RIG, sub), join(dir, sub), { recursive: true });
  }
  const base = readYaml(join(RIG, 'agent.base.yaml'));
  const probe = readYaml(join(RIG, 'probe.yaml'));
  const agentEnv = Object.fromEntries(
    Object.entries(profile.connector.env ?? {}).map(([k, v]) => [
      k,
      v.replaceAll('{state}', STATE),
    ]),
  );
  if (loginDir !== undefined) {
    agentEnv[login.dir.env] = loginDir;
  }
  const config = {
    ...base,
    db: resolve(RIG, base.db),
    socket: resolve(RIG, base.socket),
    tasks: 'tasks.yaml',
    connectors: [
      { ...probe, cwd: RIG, env: { SMOKE_PROBE_STAMP: stamp } },
      { name: AGENT, ...profile.connector, env: agentEnv },
    ],
    defaults: { ...base.defaults, agent: { ...base.defaults.agent, connector: AGENT } },
    ...(profile.pricing === undefined ? {} : { pricing: profile.pricing }),
  };
  const { tasks } = readYaml(join(RIG, 'tasks.yaml'));
  for (const task of tasks) {
    const a = task.action;
    for (const [key, value] of Object.entries(profile.tasks ?? {})) {
      a[key] ??= value;
    }
    if (task.name === 'smoke_override') {
      a.model = profile.override.model;
      a.effort = profile.override.effort;
    }
  }
  const header = `# Generated by test/smoke/acp/run.mjs for ${AGENT}; edits are overwritten.\n`;
  writeFileSync(join(dir, 'agent.yaml'), header + stringify(config));
  writeFileSync(join(dir, 'tasks.yaml'), header + stringify({ tasks }));
  return join(dir, 'agent.yaml');
}

const canary = `canary-${randomBytes(12).toString('hex')}`;
const stamp = `stamp-${randomBytes(6).toString('hex')}`;
say(`smoke:acp: rig ${RIG}`);
mkdirSync(STATE, { recursive: true });
const CONFIG = buildConfig(stamp);
try {
  process.stdout.write(oa(['validate', CONFIG], { socket: false }));
} catch (err) {
  die(`the generated config does not validate:\n${err.message}`);
}

// A fresh fixture repo per run; old workspaces are worktrees of the previous one. The
// database stays, so the daily cap and `oa cost` cover every run of the day.
rmSync(REPO, { recursive: true, force: true });
rmSync(join(STATE, 'work'), { recursive: true, force: true });
cpSync(join(RIG, 'repo'), REPO, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'agent']);
git(['config', 'user.email', 'agent@example.com']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'init']);

// --- daemon ----------------------------------------------------------------------------

const env = {
  ...process.env,
  OA_SECRET_SMOKE_CANARY: canary,
};
delete env.OA_CORE_SOCKET;

const logFd = openSync(LOG, 'w');
const daemon = spawn(process.execPath, [CORE, '--config', CONFIG], {
  cwd: RIG,
  env,
  stdio: ['ignore', logFd, logFd],
});
let exited = false;
daemon.on('exit', () => {
  exited = true;
});

async function stop() {
  if (exited) {
    return;
  }
  daemon.kill('SIGTERM');
  for (let i = 0; i < 100 && !exited; i++) {
    await sleep(200);
  }
  if (!exited) {
    daemon.kill('SIGKILL');
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void stop().then(() => process.exit(130));
  });
}

async function waitForConnectors() {
  const deadline = Date.now() + STARTUP_MS;
  let last = 'no answer from the daemon';
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`the daemon exited during startup; see ${LOG}`);
    }
    try {
      const { connectors } = JSON.parse(oa(['connector', 'list', '--json']));
      const states = Object.fromEntries(connectors.map((c) => [c.name, c.state]));
      if (states[AGENT] === 'up' && states.probe === 'up') {
        return;
      }
      last = JSON.stringify(states);
    } catch {
      // Socket not there yet.
    }
    await sleep(500);
  }
  throw new Error(`connectors not up after ${STARTUP_MS / 1000}s (${last}); see ${LOG}`);
}

// --- checks ----------------------------------------------------------------------------

const results = [];
function check(task, name, ok, detail = '') {
  results.push({ task, name, ok, detail });
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
}

function runTask(task) {
  say(`\n${task}`);
  const { run } = JSON.parse(oa(['run', task, '--wait', '--json'], { failedOk: true }));
  if (run.status === 'failed' && AUTH_ERROR.test(String(run.error))) {
    throw new Error(
      `the ${AGENT} login${loginDir === undefined ? '' : ` at ${loginDir}`} does not work (${run.error})${login.hint === undefined ? '' : `; ${login.hint}, then try again`}`,
    );
  }
  check(
    task,
    'run succeeded',
    run.status === 'succeeded',
    `${run.status} ${run.id}${run.error ? `: ${run.error}` : ''}`,
  );
  return run;
}

function agentConfig(runId) {
  return logLines().find((l) => l.msg === 'agent.config' && l.run_id === runId);
}

const runs = {};
let exitCode;
try {
  say(`smoke:acp: starting the daemon with ${AGENT}`);
  await waitForConnectors();

  {
    const run = (runs.smoke_done = runTask('smoke_done'));
    const r = run.result ?? {};
    check('smoke_done', 'status done', r.status === 'done', String(r.summary ?? ''));
    check(
      'smoke_done',
      'edited items.txt',
      Array.isArray(r.files_changed) && r.files_changed.includes('items.txt'),
      JSON.stringify(r.files_changed),
    );
    let subject = '';
    try {
      subject = git(['log', '-1', '--format=%s', `agent/${run.id}`]).trim();
    } catch {
      // No branch: the run never got a workspace.
    }
    check('smoke_done', 'post gates committed', subject.startsWith('items: '), subject);
  }
  {
    const r = (runs.smoke_blocked = runTask('smoke_blocked')).result ?? {};
    check('smoke_blocked', 'status blocked', r.status === 'blocked', String(r.summary ?? ''));
    check(
      'smoke_blocked',
      'names what is missing',
      Array.isArray(r.missing) && r.missing.length > 0,
      JSON.stringify(r.missing),
    );
  }
  {
    const run = (runs.smoke_mcp = runTask('smoke_mcp'));
    const r = run.result ?? {};
    const calls = logLines().filter((l) => l.msg === 'agent.mcp_call' && l.run_id === run.id);
    check(
      'smoke_mcp',
      'agent.mcp_call logged',
      calls.some((c) => c.connector === 'probe' && c.op === 'stamp' && c.ok === true),
      `${calls.length} call(s)`,
    );
    check(
      'smoke_mcp',
      'stamp round-tripped',
      r.stamp === stamp,
      `got ${JSON.stringify(r.stamp)}, want ${stamp}`,
    );
  }
  {
    const { model, effort, reports = model } = profile.override;
    const run = (runs.smoke_override = runTask('smoke_override'));
    const line = agentConfig(run.id);
    check(
      'smoke_override',
      'agent.config logged',
      line !== undefined,
      line === undefined ? 'no line' : `model=${line.model} effort=${line.effort}`,
    );
    check('smoke_override', `model ${reports}`, line?.model === reports, String(line?.model));
    check('smoke_override', `effort ${effort}`, line?.effort === effort, String(line?.effort));
    const base = agentConfig(runs.smoke_done.id);
    check(
      'smoke_override',
      'the other runs kept their model',
      base !== undefined && base.model !== reports,
      `smoke_done model=${String(base?.model)}`,
    );
  }

  // Nothing the runs left behind may hold the canary as is: the transcripts (`oa runs logs`),
  // the run records (results, errors), the events and the daemon's log. The smoke_mcp
  // transcript must show it redacted, or the scan proves nothing.
  say('\nredaction');
  for (const [task, run] of Object.entries(runs)) {
    const transcript = oa(['runs', 'logs', run.id, '--json']);
    const record = oa(['runs', 'show', run.id, '--json'], { failedOk: true });
    check(
      task,
      'no secret in transcript or run record',
      !transcript.includes(canary) &&
        !record.includes(canary) &&
        !KEY.test(transcript) &&
        !KEY.test(record),
    );
  }
  const mcpTranscript = oa(['runs', 'logs', runs.smoke_mcp.id, '--json']);
  check(
    'smoke_mcp',
    'canary shown as [secret:smoke_canary]',
    mcpTranscript.includes('[secret:smoke_canary]'),
  );
  const events = oa(['events', 'tail', '--json']);
  check('events', 'no canary in events', !events.includes(canary));
  check('daemon', 'no canary in the daemon log', !readFileSync(LOG, 'utf8').includes(canary));

  say('\noa cost (24h, every smoke run)');
  process.stdout.write(oa(['cost', '--by', 'provider']));
  process.stdout.write(oa(['cost', '--by', 'model']));

  const failed = results.filter((r) => !r.ok);
  say(
    `\nsmoke:acp: ${AGENT}: ${results.length - failed.length}/${results.length} checks passed; daemon log ${LOG}`,
  );
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`smoke:acp: ${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 2;
} finally {
  say('smoke:acp: stopping the daemon');
  await stop();
}
process.exit(exitCode);
