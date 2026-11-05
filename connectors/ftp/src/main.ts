/**
 * The (S)FTP connector: files inside one remote directory over SFTP, FTP or FTPS. Ops:
 * `list`, `stat`, `read`, `write`, `delete`, `rename`, `mkdir`, `sync`. Spawned by the core with
 * the manifest's `config` in `OA_CONFIG_JSON`; see README.md.
 */
import { runConnector } from '@247-agent/connector-sdk';

import { configWarnings, parseConfig } from './config.js';
import { connectFtp } from './ftp.js';
import { FileOps } from './ops.js';
import { connectSftp } from './sftp.js';
import { ftpTools } from './tools.js';

await runConnector({
  version: '0.1.0',
  tools: (rt) => {
    const config = parseConfig(rt.env.config);
    rt.log(
      `ftp: ${config.protocol}://${config.host}:${String(config.port)} root=${config.root}` +
        (config.protocol === 'ftps' ? ` tls=${config.tls}` : ''),
    );
    for (const warning of configWarnings(config)) {
      rt.log(warning);
    }
    const ops = new FileOps(
      config,
      rt.log,
      config.protocol === 'sftp' ? (c) => connectSftp(c) : (c) => connectFtp(c),
    );

    return ftpTools(ops);
  },
});
