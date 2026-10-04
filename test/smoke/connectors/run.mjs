// The connector smoke run (`npm run smoke:connectors [-- <connector>…] [--keep]`, README.md):
// for every connector with a connectors/<name>/test/smoke/compose.yaml (or the ones named),
// brings its servers up with podman, starts a daemon on the real connectors its smoke.mjs
// declares, runs that module's checks through `oa run`, scans what the runs left behind for
// the servers' passwords, stops the daemon and tears the servers down.
// Exits 0 when every check passed, 1 when one failed, 2 when the rig could not start.
// Needs `npm run build` and podman with a compose provider (`podman compose`).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stringify } from 'yaml';

const RIG = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(RIG, '../../..');
const STATE = join(RIG, '.state');
const SOCKET = join(STATE, 'core.sock');
const LOG = join(STATE, 'daemon.log');
const CONFIG = join(STATE, 'agent.yaml');
const CORE = join(ROOT, 'packages/core/dist/main.js');
const OA = join(ROOT, 'packages/cli/dist/main.js');
/** Image pulls on the first run count against this, so it is generous. */
const SERVERS_MS = 300_000;
const CONNECTORS_MS = 30_000;

const say = (line) => process.stdout.write(`${line}\n`);
const die = (msg) => {
  process.stderr.write(`smoke:connectors: ${msg}\n`);
  process.exit(2);
};

/** `oa <args>` against the rig's socket; returns stdout. Exit 1 with `failedOk` still returns it. */
function oa(args, opts = {}) {
  try {
    return execFileSync(
      process.execPath,
      [OA, ...args, ...(opts.socket === false ? [] : ['--socket', SOCKET])],
      {
        cwd: STATE,
        encoding: 'utf8',
        input: opts.input,
        stdio: ['pipe', 'pipe', 'pipe'],
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

/** `podman compose` for one connector's servers; the provider's output is kept for errors. */
function compose(name, args) {
  const file = join(ROOT, 'connectors', name, 'test/smoke/compose.yaml');
  const r = spawnSync('podman', ['compose', '-p', `oa-smoke-${name}`, '-f', file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PODMAN_COMPOSE_WARNING_LOGS: 'false' },
  });
  if (r.error !== undefined || r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    throw new Error(
      `podman compose ${args.join(' ')} (${name}) failed: ${r.error?.message ?? out.split('\n').slice(-15).join('\n')}`,
    );
  }
}

/** Resolves once something listens on 127.0.0.1:port and sends a first byte (a banner). */
function greets(port) {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port });
    const finish = (ok) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(2000, () => finish(false));
    s.once('data', () => finish(true));
    s.once('error', () => finish(false));
    s.once('close', () => finish(false));
  });
}

async function waitForPorts(name, ports) {
  const deadline = Date.now() + SERVERS_MS;
  for (const port of ports) {
    while (!(await greets(port))) {
      if (Date.now() > deadline) {
        throw new Error(`${name}: nothing greets on 127.0.0.1:${port} after ${SERVERS_MS / 1000}s`);
      }
      await sleep(500);
    }
  }
}

// --- arguments and preflight -----------------------------------------------------------

const AVAILABLE = readdirSync(join(ROOT, 'connectors'))
  .filter((c) => existsSync(join(ROOT, 'connectors', c, 'test/smoke/compose.yaml')))
  .sort();
const USAGE = `usage: npm run smoke:connectors [-- [--keep] <connector>…]

connectors: ${AVAILABLE.join(', ')} (connectors/<name>/test/smoke/); default: all
--keep      leave the servers running afterwards (podman compose -p oa-smoke-<name> down -v)
`;
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const KEEP = argv.includes('--keep');
const named = argv.filter((a) => a !== '--keep');
const unknown = named.filter((a) => !AVAILABLE.includes(a));
if (unknown.length > 0) {
  process.stderr.write(`smoke:connectors: unknown connector "${unknown.join(' ')}"\n${USAGE}`);
  process.exit(2);
}
const SELECTED = named.length === 0 ? AVAILABLE : [...new Set(named)].sort();

for (const [file, what] of [
  [CORE, 'the daemon'],
  [OA, 'the oa command'],
  ...SELECTED.map((c) => [join(ROOT, 'connectors', c, 'dist/main.js'), `the ${c} connector`]),
]) {
  if (!existsSync(file)) {
    die(`${what} is not built (${file}); run npm run build first`);
  }
}
{
  const r = spawnSync('podman', ['compose', 'version'], {
    encoding: 'utf8',
    env: { ...process.env, PODMAN_COMPOSE_WARNING_LOGS: 'false' },
  });
  if (r.error !== undefined || r.status !== 0) {
    die(
      `podman compose is not available (${r.error?.message ?? String(r.stderr).trim()}); install podman and docker-compose or podman-compose`,
    );
  }
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

// --- the rig each smoke.mjs works against ----------------------------------------------

const results = [];
const runs = [];
const manifests = [];
const tasks = [];
const fieldsOf = new Map();
const secrets = {};

const rig = {
  /** This connector's scratch directory under .state/ (fresh per run). */
  dir: undefined,
  /** Adds a connector manifest to the daemon config. */
  connector(manifest) {
    manifests.push({ transport: 'stdio', restart: { base: '1s', max: '30s' }, ...manifest });
  },
  /** A secret the daemon resolves as `${secrets.<name>}`; the scan looks for its value. */
  secret(name, value) {
    secrets[name] = value;
  },
  /**
   * Declares the manual task `name` calling `connector.op` with `fields` taken from the
   * event payload. A field absent from the payload would render as null, which an op's
   * schema rejects, so `call` must pass exactly these fields; declare one task per shape.
   */
  op(name, connector, op, fields) {
    tasks.push({
      name,
      trigger: { kind: 'manual' },
      action: {
        kind: 'connector',
        connector,
        op,
        args: Object.fromEntries(fields.map((f) => [f, `\${event.payload.${f}}`])),
      },
    });
    fieldsOf.set(name, [...fields].sort());
  },
  /** Runs a declared task with `payload` and waits; returns the run record. */
  call(task, payload = {}) {
    const want = fieldsOf.get(task);
    const got = Object.keys(payload).sort();
    if (want === undefined || want.join() !== got.join()) {
      throw new Error(
        `rig: ${task} takes ${want === undefined ? 'nothing (undeclared)' : JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    }
    const { run } = JSON.parse(
      oa(['run', task, '--wait', '--json', '--event', '-'], {
        input: JSON.stringify({ payload }),
        failedOk: true,
      }),
    );
    runs.push(run);
    return run;
  },
  section(title) {
    say(`\n${title}`);
  },
  check(name, ok, detail = '') {
    results.push({ name, ok });
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
    return ok;
  },
  /** Checks that `run` succeeded; returns its result ({} when it failed). */
  succeeded(name, run) {
    const ok = run.status === 'succeeded';
    this.check(name, ok, ok ? '' : `${run.status} ${run.id}: ${String(run.error)}`);
    return ok ? (run.result ?? {}) : {};
  },
  /** Checks that `run` failed with an error matching `pattern`. */
  failed(name, run, pattern) {
    return this.check(
      name,
      run.status === 'failed' && pattern.test(String(run.error)),
      run.status === 'failed' ? String(run.error) : `${run.status}, want failed (${pattern})`,
    );
  },
};

// --- modules, servers, config ----------------------------------------------------------

rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const modules = [];
for (const name of SELECTED) {
  const mod = await import(
    pathToFileURL(join(ROOT, 'connectors', name, 'test/smoke/smoke.mjs')).href
  );
  rig.dir = join(STATE, name);
  mkdirSync(rig.dir, { recursive: true });
  mod.setup(rig);
  modules.push({ name, mod, dir: rig.dir });
}

const up = [];
async function teardown() {
  if (KEEP) {
    if (up.length > 0) {
      say(
        `smoke:connectors: servers left running; stop them with ${up.map((n) => `podman compose -p oa-smoke-${n} -f connectors/${n}/test/smoke/compose.yaml down -v`).join(' && ')}`,
      );
    }
    return;
  }
  for (const name of up.splice(0)) {
    say(`smoke:connectors: removing the ${name} servers`);
    try {
      compose(name, ['down', '-v', '-t', '1']);
    } catch (err) {
      process.stderr.write(`smoke:connectors: ${err.message}\n`);
    }
  }
}

let daemon;
let exited = true;
async function stop() {
  if (!exited) {
    daemon.kill('SIGTERM');
    for (let i = 0; i < 100 && !exited; i++) {
      await sleep(100);
    }
    if (!exited) {
      daemon.kill('SIGKILL');
    }
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void stop()
      .then(teardown)
      .then(() => process.exit(130));
  });
}

async function waitForConnectors() {
  const want = manifests.map((m) => m.name);
  const deadline = Date.now() + CONNECTORS_MS;
  let last = 'no answer from the daemon';
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`the daemon exited during startup; see ${LOG}`);
    }
    try {
      const { connectors } = JSON.parse(oa(['connector', 'list', '--json']));
      const states = Object.fromEntries(connectors.map((c) => [c.name, c.state]));
      if (want.every((n) => states[n] === 'up')) {
        return;
      }
      last = JSON.stringify(states);
    } catch {
      // Socket not there yet.
    }
    await sleep(300);
  }
  throw new Error(`connectors not up after ${CONNECTORS_MS / 1000}s (${last}); see ${LOG}`);
}

let exitCode;
try {
  for (const { name, mod } of modules) {
    say(`smoke:connectors: starting the ${name} servers (podman compose -p oa-smoke-${name})`);
    // A clean slate: a previous run killed before its teardown leaves containers behind.
    compose(name, ['down', '-v', '-t', '1']);
    up.push(name);
    compose(name, ['up', '-d']);
    await waitForPorts(name, mod.ports);
  }

  const header = '# Generated by test/smoke/connectors/run.mjs; edits are overwritten.\n';
  writeFileSync(
    CONFIG,
    header +
      stringify({
        db: join(STATE, 'state.db'),
        socket: SOCKET,
        workers: 4,
        log: { level: 'debug' },
        defaults: { timeout: '2m', retry: { attempts: 1 } },
        secrets: { backend: 'env' },
        connectors: manifests,
        tasks: 'tasks.yaml',
      }),
  );
  writeFileSync(join(STATE, 'tasks.yaml'), header + stringify({ tasks }));
  try {
    oa(['validate', CONFIG], { socket: false });
  } catch (err) {
    throw new Error(`the generated config does not validate:\n${err.message}`, { cause: err });
  }

  const env = { ...process.env };
  delete env.OA_CORE_SOCKET;
  for (const [name, value] of Object.entries(secrets)) {
    env[`OA_SECRET_${name.toUpperCase()}`] = value;
  }
  say(`smoke:connectors: starting the daemon with ${manifests.length} connectors`);
  const logFd = openSync(LOG, 'w');
  daemon = spawn(process.execPath, [CORE, '--config', CONFIG], {
    cwd: STATE,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  exited = false;
  daemon.on('exit', () => {
    exited = true;
  });
  await waitForConnectors();

  for (const { name, mod, dir } of modules) {
    rig.dir = dir;
    say(`\n== ${name}`);
    await mod.run(rig);
  }

  // The servers' passwords reach the connectors as rendered config only: never a run
  // record, an event or a line of the daemon's log (which carries the connectors' stderr).
  rig.section('redaction');
  const records = JSON.stringify(runs);
  const events = oa(['events', 'tail', '--json']);
  const log = readFileSync(LOG, 'utf8');
  for (const [name, value] of Object.entries(secrets)) {
    rig.check(`${name} in no run record`, !records.includes(value));
    rig.check(`${name} in no event`, !events.includes(value));
    rig.check(`${name} not in the daemon log`, !log.includes(value));
  }

  const failed = results.filter((r) => !r.ok);
  say(
    `\nsmoke:connectors: ${SELECTED.join(', ')}: ${results.length - failed.length}/${results.length} checks passed; daemon log ${LOG}`,
  );
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  process.stderr.write(`smoke:connectors: ${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 2;
} finally {
  if (!exited) {
    say('smoke:connectors: stopping the daemon');
  }
  await stop();
  await teardown();
}
process.exit(exitCode);
