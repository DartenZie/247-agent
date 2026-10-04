// The ftp connector against the servers of compose.yaml, for `npm run smoke:connectors`
// (test/smoke/connectors/README.md). One connector per protocol (SFTP, FTP, explicit FTPS)
// runs the same scenario: every op, `max_bytes` on write and read, `sync` with and without
// prune, and the path refusals. Two more must fail: `ftp_offline` points at a closed
// port, so a `../x` that fails as a bad path there was refused before any connection, and
// `ftp_ftps_verify` keeps `reject_unauthorized` on against the self-signed certificate.
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PASS = 'smoke-ftp-pass';
const HOST = '127.0.0.1';
const MAX_BYTES = 4096;

/** Ports that greet once the servers are up. */
export const ports = [2222, 2121, 2122];

const PROTOCOLS = [
  {
    name: 'ftp_sftp',
    label: 'SFTP 2222 (OpenSSH, atmoz/sftp)',
    config: { protocol: 'sftp', port: 2222, root: 'upload' },
  },
  {
    name: 'ftp_ftp',
    label: 'FTP 2121 (vsftpd)',
    config: { protocol: 'ftp', port: 2121 },
  },
  {
    name: 'ftp_ftps',
    label: 'FTPS explicit 2122 (vsftpd, TLS forced)',
    config: { protocol: 'ftps', port: 2122, tls: 'explicit', reject_unauthorized: false },
  },
];

const OPS = {
  list: ['path', 'limit'],
  stat: ['path'],
  read: ['path', 'encoding'],
  write: ['path', 'content', 'encoding', 'overwrite'],
  delete: ['path', 'recursive', 'missing_ok'],
  rename: ['from', 'to', 'parents'],
  mkdir: ['path'],
  sync: ['local', 'remote', 'prune'],
};

function connector(rig, name, config) {
  rig.connector({
    name,
    exec: ['247-agent-connector-ftp'],
    ops: Object.keys(OPS),
    config: {
      host: HOST,
      user: 'smoke',
      password: '${secrets.smoke_ftp_pass}',
      max_bytes: MAX_BYTES,
      timeout: 10000,
      local_roots: [join(rig.dir, 'site')],
      ...config,
    },
  });
  for (const [op, fields] of Object.entries(OPS)) {
    rig.op(`${name}_${op}`, name, op, fields);
  }
}

export function setup(rig) {
  rig.secret('smoke_ftp_pass', PASS);
  for (const p of PROTOCOLS) {
    connector(rig, p.name, p.config);
  }
  connector(rig, 'ftp_offline', { protocol: 'sftp', port: 1 });
  connector(rig, 'ftp_ftps_verify', { protocol: 'ftps', port: 2122, tls: 'explicit' });
}

const names = (entries) => JSON.stringify((entries ?? []).map((e) => e.name));

function scenario(rig, { name, label }) {
  rig.section(`${name}: ${label}`);
  const call = (op, payload) => rig.call(`${name}_${op}`, payload);
  const text = `hello from ${name}\n`;

  const w = rig.succeeded(
    'write into a new directory',
    call('write', { path: 'smoke/notes/a.txt', content: text, encoding: 'utf8', overwrite: true }),
  );
  rig.check(
    'write result',
    w.path === 'smoke/notes/a.txt' && w.size === text.length,
    JSON.stringify(w),
  );
  const l = rig.succeeded('list', call('list', { path: 'smoke/notes', limit: 100 }));
  rig.check(
    'list entries',
    names(l.entries) === '["a.txt"]' &&
      l.entries[0].path === 'smoke/notes/a.txt' &&
      l.entries[0].type === 'file' &&
      l.entries[0].size === text.length,
    JSON.stringify(l.entries),
  );
  const s = rig.succeeded('stat', call('stat', { path: 'smoke/notes/a.txt' }));
  rig.check(
    'stat a file',
    s.exists === true && s.type === 'file' && s.size === text.length,
    JSON.stringify(s),
  );
  const missing = rig.succeeded('stat a missing path', call('stat', { path: 'smoke/nope' }));
  rig.check('exists: false', missing.exists === false, JSON.stringify(missing));
  const r = rig.succeeded('read', call('read', { path: 'smoke/notes/a.txt', encoding: 'utf8' }));
  rig.check('read content', r.content === text, JSON.stringify(r.content));

  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('base64');
  rig.succeeded(
    'write base64',
    call('write', { path: 'smoke/bin.dat', content: bytes, encoding: 'base64', overwrite: true }),
  );
  const b = rig.succeeded(
    'read base64',
    call('read', { path: 'smoke/bin.dat', encoding: 'base64' }),
  );
  rig.check('binary round trip', b.content === bytes && b.size === 256, `size ${b.size}`);
  rig.failed(
    'overwrite: false on an existing file',
    call('write', { path: 'smoke/notes/a.txt', content: 'x', encoding: 'utf8', overwrite: false }),
    /already exists/,
  );

  rig.succeeded(
    'rename into a new directory',
    call('rename', { from: 'smoke/notes/a.txt', to: 'smoke/moved/deep/b.txt', parents: true }),
  );
  const moved = rig.succeeded('stat the target', call('stat', { path: 'smoke/moved/deep/b.txt' }));
  const gone = rig.succeeded('stat the source', call('stat', { path: 'smoke/notes/a.txt' }));
  rig.check(
    'moved',
    moved.exists === true && gone.exists === false,
    JSON.stringify([moved.exists, gone.exists]),
  );
  rig.succeeded('mkdir -p', call('mkdir', { path: 'smoke/x/y' }));
  rig.succeeded('mkdir on an existing directory', call('mkdir', { path: 'smoke/x/y' }));
  const dir = rig.succeeded('stat the directory', call('stat', { path: 'smoke/x/y' }));
  rig.check('a directory', dir.type === 'dir', JSON.stringify(dir));

  rig.failed(
    `write over max_bytes (${MAX_BYTES})`,
    call('write', {
      path: 'smoke/big.txt',
      content: 'x'.repeat(MAX_BYTES + 1),
      encoding: 'utf8',
      overwrite: true,
    }),
    /exceeds max_bytes/,
  );

  // A local tree per connector; `sync` is not capped, which puts a file over max_bytes on
  // the server for `read` to refuse.
  const local = join(rig.dir, 'site', name);
  rmSync(local, { recursive: true, force: true });
  mkdirSync(join(local, 'assets'), { recursive: true });
  writeFileSync(join(local, 'index.html'), `<h1>${name}</h1>\n`);
  writeFileSync(join(local, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(local, 'big.bin'), Buffer.alloc(MAX_BYTES + 1000, 7));
  const sync = rig.succeeded('sync', call('sync', { local, remote: 'site', prune: false }));
  rig.check(
    'uploaded every file',
    JSON.stringify([...(sync.uploaded ?? [])].sort()) ===
      '["assets/app.js","big.bin","index.html"]' &&
      sync.bytes === MAX_BYTES + 1000 + `<h1>${name}</h1>\n`.length + 'console.log(1);\n'.length,
    JSON.stringify([sync.uploaded, sync.bytes]),
  );
  const page = rig.succeeded(
    'read a synced file',
    call('read', { path: 'site/index.html', encoding: 'utf8' }),
  );
  rig.check('synced content', page.content === `<h1>${name}</h1>\n`, JSON.stringify(page.content));
  rig.failed(
    'read over max_bytes',
    call('read', { path: 'site/big.bin', encoding: 'utf8' }),
    /exceeds max_bytes/,
  );
  rmSync(join(local, 'assets'), { recursive: true });
  const pruned = rig.succeeded(
    'sync with prune',
    call('sync', { local, remote: 'site', prune: true }),
  );
  rig.check(
    'pruned what the local tree lacks',
    JSON.stringify([...(pruned.pruned ?? [])].sort()) === '["assets","assets/app.js"]',
    JSON.stringify(pruned.pruned),
  );
  const after = rig.succeeded('list after prune', call('list', { path: 'site', limit: 100 }));
  rig.check(
    'remote mirrors local',
    names(after.entries) === '["big.bin","index.html"]',
    names(after.entries),
  );
  rig.failed(
    'sync outside local_roots',
    call('sync', { local: rig.dir, remote: 'site', prune: false }),
    /outside local_roots/,
  );

  rig.failed('read ../x', call('read', { path: '../x', encoding: 'utf8' }), /invalid path/);
  rig.failed(
    'write ../x',
    call('write', { path: '../x', content: 'x', encoding: 'utf8', overwrite: true }),
    /invalid path/,
  );
  rig.failed(
    'rename to ../x',
    call('rename', { from: 'smoke/bin.dat', to: '../x', parents: false }),
    /invalid path/,
  );
  rig.failed('sync to ../x', call('sync', { local, remote: '../x', prune: false }), /invalid path/);
  rig.failed(
    'delete the root',
    call('delete', { path: '.', recursive: true, missing_ok: false }),
    /root/,
  );

  const top = rig.succeeded('list with limit 1', call('list', { path: '.', limit: 1 }));
  rig.check('truncated', top.truncated === true && top.entries?.length === 1, JSON.stringify(top));
  for (const path of ['smoke', 'site']) {
    const d = rig.succeeded(
      `delete ${path} recursively`,
      call('delete', { path, recursive: true, missing_ok: false }),
    );
    rig.check(`deleted ${path}`, d.deleted === true && d.type === 'dir', JSON.stringify(d));
  }
  rig.failed(
    'delete a missing path',
    call('delete', { path: 'smoke', recursive: false, missing_ok: false }),
    /not found/,
  );
  const ok = rig.succeeded(
    'delete with missing_ok',
    call('delete', { path: 'smoke', recursive: false, missing_ok: true }),
  );
  rig.check('deleted: false', ok.deleted === false, JSON.stringify(ok));
  const empty = rig.succeeded('list the root', call('list', { path: '.', limit: 100 }));
  rig.check('nothing left behind', names(empty.entries) === '[]', names(empty.entries));
}

function refusals(rig) {
  rig.section('refusals: before connecting, an unverified certificate');
  rig.failed(
    '../x on a closed port is a path error',
    rig.call('ftp_offline_read', { path: '../x', encoding: 'utf8' }),
    /invalid path/,
  );
  const list = rig.call('ftp_offline_list', { path: '.', limit: 10 });
  rig.failed('while list there cannot connect', list, /ECONNREFUSED|connect/i);
  rig.failed(
    'FTPS, self-signed certificate',
    rig.call('ftp_ftps_verify_list', { path: '.', limit: 10 }),
    /certificate/i,
  );
}

export function run(rig) {
  for (const p of PROTOCOLS) {
    scenario(rig, p);
  }
  refusals(rig);
}
