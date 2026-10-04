// The webhook connector for `npm run smoke:connectors` (test/smoke/connectors/README.md). It
// is the server itself, so there is no compose.yaml: the real connector program listens
// under the real daemon, this module is the sender (GitHub, GitLab, a deploy hook, a proxy),
// and every accepted request is checked where it lands: the daemon's event store, and the
// run of the task it triggers. Two listeners: TCP with every verify kind, and a Unix socket
// behind a trusted proxy. The secrets must never show up in an event or in the database.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOST = '127.0.0.1';
const PORT = 38787;
const MAX_BODY = 2048;

// GitHub's documented test vector (docs.github.com, "Validating webhook deliveries"): this
// secret and body give this signature, so the check is proven against GitHub's own numbers.
const GITHUB_SECRET = "It's a Secret to Everybody";
const GITHUB_BODY = 'Hello, World!';
const GITHUB_SIGNATURE = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const DEPLOY_TOKEN = 'smoke-deploy-token-9f1c';
const GITLAB_TOKEN = 'smoke-gitlab-token-27ab';
const HMAC_SECRET = 'smoke-hmac-secret-55e0';
const PROXY_KEY = 'smoke-proxy-key-c3d4';

/** The connector listens only once the daemon runs; nothing to wait for before that. */
export const ports = [];

let socketPath;

export function setup(rig) {
  socketPath = join(rig.dir, 'http.sock');
  rig.secret('smoke_github_secret', GITHUB_SECRET);
  rig.secret('smoke_deploy_token', DEPLOY_TOKEN);
  rig.secret('smoke_gitlab_token', GITLAB_TOKEN);
  rig.secret('smoke_hmac_secret', HMAC_SECRET);
  rig.secret('smoke_proxy_key', PROXY_KEY);
  rig.connector({
    name: 'webhook_tcp',
    exec: ['247-agent-connector-webhook'],
    transport: 'none',
    emits: ['github.push', 'github.ping', 'deploy.requested', 'gitlab.push_hook', 'smoke.signed'],
    config: {
      listen: { host: HOST, port: PORT },
      max_body: MAX_BODY,
      drop_headers: ['x-secret-note'],
      routes: [
        {
          path: '/hooks/github',
          event: 'github',
          type_header: 'X-GitHub-Event',
          dedup_header: 'X-GitHub-Delivery',
          verify: { kind: 'github', secret: '${secrets.smoke_github_secret}' },
        },
        {
          path: '/hooks/deploy',
          event: 'deploy.requested',
          verify: { kind: 'token', token: '${secrets.smoke_deploy_token}' },
        },
        {
          path: '/hooks/gitlab',
          event: 'gitlab',
          type_header: 'X-Gitlab-Event',
          verify: { kind: 'gitlab', token: '${secrets.smoke_gitlab_token}' },
        },
        {
          path: '/hooks/signed',
          name: 'signed',
          event: 'smoke.signed',
          methods: ['POST', 'PUT'],
          verify: {
            kind: 'hmac',
            secret: '${secrets.smoke_hmac_secret}',
            header: 'X-Signature',
            algorithm: 'sha1',
            encoding: 'base64',
            prefix: 'v1=',
          },
        },
        {
          path: '/hooks/open',
          event: 'smoke.open',
          methods: ['GET', 'POST'],
          verify: { kind: 'none' },
        },
      ],
    },
  });
  rig.connector({
    name: 'webhook_unix',
    exec: ['247-agent-connector-webhook'],
    transport: 'none',
    emits: ['deploy.unix'],
    config: {
      listen: { path: socketPath, mode: '0600' },
      trust_proxy: true,
      routes: [
        {
          path: '/hooks/deploy',
          event: 'deploy.unix',
          verify: {
            kind: 'token',
            token: '${secrets.smoke_proxy_key}',
            header: 'X-Api-Key',
            scheme: '',
          },
        },
      ],
    },
  });
  // What the events are for: a push to main runs this, anything else does not.
  rig.task({
    name: 'webhook_deploy_on_push',
    trigger: {
      kind: 'event',
      type: 'github.push',
      filter: "payload.body.ref == 'refs/heads/main'",
    },
    action: { kind: 'shell', cmd: ['echo', 'deploy ${event.payload.body.after}'] },
  });
}

/** One HTTP request; `body` is a string or a Buffer, sent as is. Returns status, headers, parsed body. */
function send({ method = 'POST', path, headers = {}, body, socket }) {
  return new Promise((resolve, reject) => {
    const target = socket === undefined ? { host: HOST, port: PORT } : { socketPath: socket };
    const req = request(
      {
        ...target,
        method,
        path,
        headers: {
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

const sign256 = (secret, body) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const sign1b64 = (secret, body) => `v1=${createHmac('sha1', secret).update(body).digest('base64')}`;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The newest event of `type` whose payload matches `pred`, waiting for it to land. */
async function eventUntil(rig, type, pred, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = rig.events(type).filter((e) => pred(e));
    if (found.length > 0 || Date.now() > deadline) {
      return found.at(-1);
    }
    await sleep(200);
  }
}

/** The runs of `task`, once none of them is still queued or running. */
async function settledRuns(rig, task, want, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const runs = rig.runs(task);
    const active = runs.filter((r) => ['queued', 'running', 'waiting'].includes(r.status));
    if ((runs.length >= want && active.length === 0) || Date.now() > deadline) {
      return runs;
    }
    await sleep(200);
  }
}

async function healthy(rig) {
  rig.section('webhook_tcp: the listener');
  let res;
  for (let i = 0; i < 50; i++) {
    try {
      res = await send({ method: 'GET', path: '/healthz' });
      break;
    } catch {
      await sleep(200);
    }
  }
  rig.check(
    'GET /healthz is 200 {ok: true}',
    res?.status === 200 && res.body.ok === true,
    JSON.stringify(res?.body ?? 'no answer'),
  );
  const nope = await send({ path: '/nope', headers: JSON_HEADERS, body: '{}' });
  rig.check('an unknown path is 404', nope.status === 404, String(nope.status));
  const get = await send({ method: 'GET', path: '/hooks/github' });
  rig.check(
    'GET on a POST route is 405 with Allow',
    get.status === 405 && get.headers.allow === 'POST',
    `${get.status} allow=${get.headers.allow}`,
  );
}

async function github(rig) {
  rig.section('webhook_tcp: /hooks/github (verify: github, type_header, dedup_header)');
  const ping = await send({
    path: '/hooks/github',
    headers: {
      'content-type': 'text/plain',
      'x-github-event': 'ping',
      'x-github-delivery': 'smoke-ping-1',
      'x-hub-signature-256': GITHUB_SIGNATURE,
      'x-secret-note': 'dropped by drop_headers',
      'user-agent': 'GitHub-Hookshot/smoke',
    },
    body: GITHUB_BODY,
  });
  rig.check(
    "GitHub's documented vector is accepted (202)",
    ping.status === 202 && typeof ping.body.event_id === 'string',
    JSON.stringify(ping.body),
  );
  const pingEvent = await eventUntil(rig, 'github.ping', (e) => e.id === ping.body.event_id);
  const p = pingEvent?.payload ?? {};
  rig.check(
    'the event is github.<X-GitHub-Event> from this connector',
    pingEvent?.type === 'github.ping' && pingEvent.source === 'webhook_tcp',
    JSON.stringify([pingEvent?.type, pingEvent?.source]),
  );
  rig.check(
    'text body kept as text',
    p.body === GITHUB_BODY && p.body_format === 'text' && p.content_type === 'text/plain',
    JSON.stringify([p.body, p.body_format, p.content_type]),
  );
  rig.check(
    'route, method, path, remote',
    p.route === 'hooks-github' &&
      p.method === 'POST' &&
      p.path === '/hooks/github' &&
      p.remote === HOST,
    JSON.stringify([p.route, p.method, p.path, p.remote]),
  );
  rig.check(
    'dedup_key names connector, route and delivery',
    pingEvent?.dedup_key === 'webhook_tcp:hooks-github:smoke-ping-1',
    String(pingEvent?.dedup_key),
  );
  rig.check(
    'the signature and drop_headers headers are not in the payload, the rest is',
    p.headers !== undefined &&
      !('x-hub-signature-256' in p.headers) &&
      !('x-secret-note' in p.headers) &&
      p.headers['x-github-event'] === 'ping' &&
      p.headers['user-agent'] === 'GitHub-Hookshot/smoke',
    JSON.stringify(p.headers),
  );

  const push = JSON.stringify({
    ref: 'refs/heads/main',
    after: 'abc123',
    repository: { full_name: 'acme/site' },
  });
  const first = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-1',
      'x-hub-signature-256': sign256(GITHUB_SECRET, push),
    },
    body: push,
  });
  rig.check('a signed push is 202', first.status === 202, JSON.stringify(first.body));
  const again = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-1',
      'x-hub-signature-256': sign256(GITHUB_SECRET, push),
    },
    body: push,
  });
  rig.check(
    'the same delivery again is 200 {duplicate: true}',
    again.status === 200 && again.body.duplicate === true,
    JSON.stringify([again.status, again.body]),
  );
  const pushEvent = await eventUntil(rig, 'github.push', (e) => e.id === first.body.event_id);
  rig.check(
    'JSON body parsed',
    pushEvent?.payload.body_format === 'json' && pushEvent.payload.body.after === 'abc123',
    JSON.stringify(pushEvent?.payload.body),
  );
  rig.check(
    'one github.push event, not two',
    rig.events('github.push').length === 1,
    String(rig.events('github.push').length),
  );

  const dev = JSON.stringify({
    ref: 'refs/heads/dev',
    after: 'def456',
    repository: { full_name: 'acme/site' },
  });
  const other = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-2',
      'x-hub-signature-256': sign256(GITHUB_SECRET, dev),
    },
    body: dev,
  });
  rig.check('a push to another branch is 202 too', other.status === 202, String(other.status));
  await eventUntil(rig, 'github.push', (e) => e.id === other.body.event_id);
  const runs = await settledRuns(rig, 'webhook_deploy_on_push', 1);
  rig.check(
    'the push to main ran the task once, the other did not',
    runs.length === 1 && runs[0].status === 'succeeded',
    JSON.stringify(runs.map((r) => [r.status, r.error])),
  );
  rig.check(
    'the task saw the payload',
    runs[0]?.result === 'deploy abc123',
    JSON.stringify(runs[0]?.result),
  );

  const bad = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-3',
      'x-hub-signature-256': sign256('wrong secret', push),
    },
    body: push,
  });
  rig.check('a wrong signature is 401', bad.status === 401, String(bad.status));
  const unsigned = await send({
    path: '/hooks/github',
    headers: { ...JSON_HEADERS, 'x-github-event': 'push', 'x-github-delivery': 'smoke-push-4' },
    body: push,
  });
  rig.check('no signature is 401', unsigned.status === 401, String(unsigned.status));
  const sha1 = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-5',
      'x-hub-signature-256': `sha1=${createHmac('sha1', GITHUB_SECRET).update(push).digest('hex')}`,
    },
    body: push,
  });
  rig.check('a sha1= prefix is 401', sha1.status === 401, String(sha1.status));
  const untyped = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-delivery': 'smoke-push-6',
      'x-hub-signature-256': sign256(GITHUB_SECRET, push),
    },
    body: push,
  });
  rig.check(
    'a signed request without X-GitHub-Event is 400',
    untyped.status === 400,
    `${untyped.status} ${JSON.stringify(untyped.body)}`,
  );
  const broken = '{"ref": ';
  const notJson = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-7',
      'x-hub-signature-256': sign256(GITHUB_SECRET, broken),
    },
    body: broken,
  });
  rig.check(
    'invalid JSON under application/json is 400',
    notJson.status === 400,
    `${notJson.status} ${JSON.stringify(notJson.body)}`,
  );
  const big = JSON.stringify({ pad: 'x'.repeat(MAX_BODY) });
  const tooBig = await send({
    path: '/hooks/github',
    headers: {
      ...JSON_HEADERS,
      'x-github-event': 'push',
      'x-github-delivery': 'smoke-push-8',
      'x-hub-signature-256': sign256(GITHUB_SECRET, big),
    },
    body: big,
  });
  rig.check(
    `a body over max_body (${MAX_BODY}) is 413`,
    tooBig.status === 413,
    String(tooBig.status),
  );
  rig.check(
    'the refused requests left no event',
    rig.events('github.push').length === 2,
    String(rig.events('github.push').length),
  );
}

async function tokens(rig) {
  rig.section(
    'webhook_tcp: /hooks/deploy (Bearer), /hooks/gitlab (X-Gitlab-Token), /hooks/signed (hmac sha1 base64), /hooks/open',
  );
  const form = 'env=prod&tag=v1&tag=v2';
  const deploy = await send({
    path: '/hooks/deploy?run=now',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${DEPLOY_TOKEN}`,
    },
    body: form,
  });
  rig.check(
    'Bearer token accepted',
    deploy.status === 202,
    JSON.stringify([deploy.status, deploy.body]),
  );
  const d =
    (await eventUntil(rig, 'deploy.requested', (e) => e.id === deploy.body.event_id))?.payload ??
    {};
  rig.check(
    'form body parsed, repeated key as array',
    d.body_format === 'form' && JSON.stringify(d.body) === '{"env":"prod","tag":["v1","v2"]}',
    JSON.stringify(d.body),
  );
  rig.check(
    'query string parsed',
    JSON.stringify(d.query) === '{"run":"now"}',
    JSON.stringify(d.query),
  );
  rig.check(
    'authorization is not in the payload',
    d.headers !== undefined && !('authorization' in d.headers),
    JSON.stringify(Object.keys(d.headers ?? {})),
  );
  rig.check(
    'no dedup_header: no dedup_key',
    (await eventUntil(rig, 'deploy.requested', (e) => e.id === deploy.body.event_id))?.dedup_key ===
      null,
  );
  const wrong = await send({
    path: '/hooks/deploy',
    headers: { authorization: 'Bearer not-the-token' },
    body: '',
  });
  rig.check('a wrong token is 401', wrong.status === 401, String(wrong.status));
  const basic = await send({
    path: '/hooks/deploy',
    headers: { authorization: `Basic ${DEPLOY_TOKEN}` },
    body: '',
  });
  rig.check('the wrong scheme is 401', basic.status === 401, String(basic.status));

  const gl = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main' });
  const gitlab = await send({
    path: '/hooks/gitlab',
    headers: { ...JSON_HEADERS, 'x-gitlab-token': GITLAB_TOKEN, 'x-gitlab-event': 'Push Hook' },
    body: gl,
  });
  rig.check(
    'GitLab token accepted',
    gitlab.status === 202,
    JSON.stringify([gitlab.status, gitlab.body]),
  );
  const g = await eventUntil(rig, 'gitlab.push_hook', (e) => e.id === gitlab.body.event_id);
  rig.check(
    '"Push Hook" folded into the type gitlab.push_hook',
    g?.type === 'gitlab.push_hook',
    String(g?.type),
  );
  rig.check(
    'x-gitlab-token is not in the payload',
    g !== undefined && !('x-gitlab-token' in g.payload.headers),
    JSON.stringify(Object.keys(g?.payload.headers ?? {})),
  );
  const glWrong = await send({
    path: '/hooks/gitlab',
    headers: { ...JSON_HEADERS, 'x-gitlab-token': 'nope', 'x-gitlab-event': 'Push Hook' },
    body: gl,
  });
  rig.check('a wrong GitLab token is 401', glWrong.status === 401, String(glWrong.status));

  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const signed = await send({
    method: 'PUT',
    path: '/hooks/signed',
    headers: {
      'content-type': 'application/octet-stream',
      'x-signature': sign1b64(HMAC_SECRET, bytes),
    },
    body: bytes,
  });
  rig.check(
    'hmac sha1/base64 with a prefix accepted on PUT',
    signed.status === 202,
    JSON.stringify([signed.status, signed.body]),
  );
  const s =
    (await eventUntil(rig, 'smoke.signed', (e) => e.id === signed.body.event_id))?.payload ?? {};
  rig.check(
    'binary body as base64',
    s.body_format === 'base64' &&
      s.body === bytes.toString('base64') &&
      s.method === 'PUT' &&
      s.route === 'signed',
    JSON.stringify([s.body_format, s.method, s.route]),
  );
  rig.check(
    'x-signature is not in the payload',
    s.headers !== undefined && !('x-signature' in s.headers),
    JSON.stringify(Object.keys(s.headers ?? {})),
  );
  const noPrefix = await send({
    path: '/hooks/signed',
    headers: { 'x-signature': createHmac('sha1', HMAC_SECRET).update(bytes).digest('base64') },
    body: bytes,
  });
  rig.check(
    'the signature without its prefix is 401',
    noPrefix.status === 401,
    String(noPrefix.status),
  );
  const del = await send({ method: 'DELETE', path: '/hooks/signed' });
  rig.check(
    'DELETE is 405 with Allow: POST, PUT',
    del.status === 405 && del.headers.allow === 'POST, PUT',
    `${del.status} allow=${del.headers.allow}`,
  );

  const open = await send({ method: 'GET', path: '/hooks/open?x=1' });
  rig.check(
    'verify: none takes a GET',
    open.status === 202,
    JSON.stringify([open.status, open.body]),
  );
  const o =
    (await eventUntil(rig, 'smoke.open', (e) => e.id === open.body.event_id))?.payload ?? {};
  rig.check(
    'an empty body is null/empty',
    o.body === null && o.body_format === 'empty' && o.method === 'GET' && o.content_type === null,
    JSON.stringify([o.body, o.body_format, o.method, o.content_type]),
  );
}

async function unix(rig) {
  rig.section('webhook_unix: a Unix socket behind a trusted proxy (X-Api-Key, trust_proxy)');
  let mode;
  for (let i = 0; i < 50 && mode === undefined; i++) {
    try {
      mode = statSync(socketPath).mode & 0o777;
    } catch {
      await sleep(200);
    }
  }
  rig.check(
    'the socket exists with mode 0600',
    mode === 0o600,
    mode === undefined ? 'no socket' : mode.toString(8),
  );
  const body = JSON.stringify({ site: 'www' });
  const fwd = await send({
    socket: socketPath,
    path: '/hooks/deploy',
    headers: {
      ...JSON_HEADERS,
      'x-api-key': PROXY_KEY,
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
    },
    body,
  });
  rig.check(
    'a bare token in X-Api-Key is accepted over the socket',
    fwd.status === 202,
    JSON.stringify([fwd.status, fwd.body]),
  );
  const f =
    (await eventUntil(rig, 'deploy.unix', (e) => e.id === fwd.body.event_id))?.payload ?? {};
  rig.check(
    'remote is the first X-Forwarded-For entry',
    f.remote === '203.0.113.9',
    String(f.remote),
  );
  rig.check(
    'x-api-key is not in the payload',
    f.headers !== undefined && !('x-api-key' in f.headers),
    JSON.stringify(Object.keys(f.headers ?? {})),
  );
  const direct = await send({
    socket: socketPath,
    path: '/hooks/deploy',
    headers: { ...JSON_HEADERS, 'x-api-key': PROXY_KEY },
    body,
  });
  const dp =
    (await eventUntil(rig, 'deploy.unix', (e) => e.id === direct.body.event_id))?.payload ?? {};
  rig.check(
    'without the header, remote is null on a socket',
    direct.status === 202 && dp.remote === null,
    JSON.stringify([direct.status, dp.remote]),
  );
  const bearer = await send({
    socket: socketPath,
    path: '/hooks/deploy',
    headers: { ...JSON_HEADERS, 'x-api-key': `Bearer ${PROXY_KEY}` },
    body,
  });
  rig.check(
    'a scheme in front of a bare token is 401',
    bearer.status === 401,
    String(bearer.status),
  );
  const tcp = await send({
    path: '/hooks/deploy',
    headers: { ...JSON_HEADERS, 'x-api-key': PROXY_KEY },
    body,
  });
  rig.check(
    "the socket's route is not served on the TCP listener",
    tcp.status === 401,
    String(tcp.status),
  );
}

export async function run(rig) {
  await healthy(rig);
  await github(rig);
  await tokens(rig);
  await unix(rig);
}
