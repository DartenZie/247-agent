// Shared by the smoke rigs (acp/run.mjs, connectors/run.mjs): the exit contract, the final
// RESULT line, a host-wide lock, cleanup of a daemon a killed run left behind, the Node
// version check and the file scan for leaked secrets.
//
// Exit contract, the same for every rig:
//   0  every check passed                                  RESULT: PASS …
//   1  a check failed: treat it as a regression             RESULT: FAIL …
//   2  the rig could not start (usage, build, login, servers, lock)   RESULT: ERROR …
//   3  acp only: the agent's provider was unavailable mid-run (outage, rate limit)
//  130 interrupted (SIGINT/SIGTERM); everything started was stopped
// Anything thrown after the first check is a FAIL of that section, never a 2.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

/** An environment problem: the rig exits 2 with it. */
export class EnvError extends Error {}

/** Prints the final line every rig ends with, and exits with `code`. */
export function finish(rig, code, summary) {
  const word = { 0: 'PASS', 1: 'FAIL', 130: 'ERROR' }[code] ?? 'ERROR';
  process.stdout.write(`RESULT: ${word} ${rig}: ${summary}\n`);
  process.exit(code);
}

/** A warning when this Node's major differs from .node-version's (production runs that one). */
export function nodeWarning(root) {
  let want;
  try {
    want = readFileSync(join(root, '.node-version'), 'utf8').trim().split('.')[0];
  } catch {
    return '';
  }
  const have = process.versions.node.split('.')[0];
  return have === want
    ? ''
    : `Node ${process.versions.node} runs this rig, but .node-version pins ${want}.x (production); results may differ`;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * A host-wide lock named `name`, so two checkouts (worktrees) never run the same rig at
 * once: they share container names, ports or the agent login. Throws EnvError when a live
 * run holds it; takes over a lock whose holder is gone. Released on process exit.
 */
export function hostLock(name, root) {
  const dir = join(tmpdir(), `${name}.lock`);
  const info = join(dir, 'owner.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(
        info,
        JSON.stringify({ pid: process.pid, root, since: new Date().toISOString() }),
      );
      process.on('exit', () => {
        try {
          const owner = JSON.parse(readFileSync(info, 'utf8'));
          if (owner.pid === process.pid) {
            rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          // Already gone.
        }
      });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      let owner = {};
      try {
        owner = JSON.parse(readFileSync(info, 'utf8'));
      } catch {
        // Half-written: treat as stale.
      }
      if (owner.pid !== undefined && alive(owner.pid)) {
        throw new EnvError(
          `another ${name} run holds the lock (pid ${owner.pid}, checkout ${owner.root}, since ${owner.since}); wait for it to finish, or kill it if it is stuck`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new EnvError(`could not take the lock ${dir}`);
}

/**
 * A daemon a killed run of this rig left behind (its pid file in `state`, its command line
 * naming `config`): stopped, so the new run can start. A live daemon that is not this rig's
 * own is an EnvError naming its pid.
 */
export async function reclaimDaemon(state, config, socket, say) {
  const pidFile = join(state, 'daemon.pid');
  if (!existsSync(pidFile)) {
    if (existsSync(socket) && socketAnswers(socket)) {
      throw new EnvError(`something already serves ${socket} and it is not this rig's daemon`);
    }
    return;
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    const cmd = commandOf(pid);
    if (!cmd.includes(config)) {
      throw new EnvError(
        `pid ${pid} from ${pidFile} is alive but is not this rig's daemon (${cmd}); stop it by hand`,
      );
    }
    say(`a daemon left by a killed run (pid ${pid}) is still up: stopping it`);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 100 && alive(pid); i++) {
      await sleep(100);
    }
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  rmSync(pidFile, { force: true });
}

function socketAnswers(socket) {
  try {
    execFileSync(
      'curl',
      ['-sf', '--max-time', '2', '--unix-socket', socket, 'http://x/v1/health'],
      {
        stdio: 'ignore',
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Every file under `dir` (recursively, skipping `skip` names) that contains one of
 * `needles` (strings, or RegExps tested on the file as latin1 text). Returns
 * `[{ file, needle }]`, needle as its label.
 */
export function scanFiles(dir, needles, skip = []) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (skip.includes(name)) {
        continue;
      }
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile()) {
        const text = readFileSync(p).toString('latin1');
        for (const { label, value } of needles) {
          if (value instanceof RegExp ? value.test(text) : text.includes(value)) {
            hits.push({ file: p, needle: label });
          }
        }
      }
    }
  };
  walk(dir);
  return hits;
}
