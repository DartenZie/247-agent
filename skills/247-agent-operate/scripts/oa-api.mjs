#!/usr/bin/env node
// Small client for the 247-agent HTTP API over its Unix socket. No dependencies.
//
//   oa-api.mjs [--socket <path>] health
//   oa-api.mjs runs [--status s] [--task t] [--limit n]
//   oa-api.mjs run <run_id>
//   oa-api.mjs event <event_id>
//   oa-api.mjs state <ns> [key] [--set <json>] [--delete]
//   oa-api.mjs <GET|POST|PUT|DELETE> <path> [json body|-]
//
// Socket: --socket, else $OA_CORE_SOCKET, else /run/247-agent/core.sock.
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (name === 'delete') {
      flags[name] = true;
    } else {
      flags[name] = argv[++i];
    }
  } else {
    positional.push(a);
  }
}

const socketPath = flags.socket ?? process.env.OA_CORE_SOCKET ?? '/run/247-agent/core.sock';

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let parsed = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            /* keep raw text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function query(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return q === '' ? '' : `?${q}`;
}

function usage() {
  process.stderr.write(
    readFileSync(new URL(import.meta.url))
      .toString()
      .split('\n')
      .slice(1, 11)
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n') + '\n',
  );
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = positional;
  let out;
  switch (cmd) {
    case 'health':
      out = await call('GET', '/v1/health');
      break;
    case 'runs':
      out = await call(
        'GET',
        `/v1/runs${query({ status: flags.status, task: flags.task, limit: flags.limit })}`,
      );
      break;
    case 'run':
      if (rest[0] === undefined) {
        usage();
      }
      out = await call('GET', `/v1/runs/${encodeURIComponent(rest[0])}`);
      break;
    case 'event':
      if (rest[0] === undefined) {
        usage();
      }
      out = await call('GET', `/v1/events/${encodeURIComponent(rest[0])}`);
      break;
    case 'state': {
      const [ns, key] = rest;
      if (ns === undefined) {
        usage();
      }
      if (key === undefined) {
        out = await call('GET', `/v1/state/${encodeURIComponent(ns)}`);
      } else if (flags.delete) {
        out = await call(
          'DELETE',
          `/v1/state/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
        );
      } else if (flags.set !== undefined) {
        out = await call('PUT', `/v1/state/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, {
          value: JSON.parse(flags.set),
        });
      } else {
        out = await call('GET', `/v1/state/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`);
      }
      break;
    }
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'DELETE': {
      const [path, body] = rest;
      if (path === undefined) {
        usage();
      }
      const payload = body === '-' ? readFileSync(0, 'utf8') : body;
      out = await call(cmd, path, payload);
      break;
    }
    default:
      usage();
  }
  process.stdout.write(JSON.stringify(out.body, null, 2) + '\n');
  process.exitCode = out.status >= 200 && out.status < 300 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(
    `oa-api: ${err.code === 'ENOENT' ? `no daemon at ${socketPath}` : err.message}\n`,
  );
  process.exitCode = 1;
});
