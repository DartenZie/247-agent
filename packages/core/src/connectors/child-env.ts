/**
 * A connector process's environment, shared by the supervisor (a child of the daemon) and
 * `247-agent-connector-host` (a `managed_by: systemd` unit). Kept apart from the supervisor
 * so the host's bundle does not pull in the ACP client, execa and the tool bridge.
 */
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { AgentSandboxConfig } from '../actions/sandbox.js';
import type { ConnectorConfig } from '../config/connector.js';
import { collectTemplateRefs, renderValue } from '../expr/template.js';
import type { SecretsBackend } from '../secrets/secrets.js';

/** The sandbox an acp manifest asks for; anything else runs as the daemon. */
export function sandboxOf(m: ConnectorConfig): AgentSandboxConfig | undefined {
  return m.transport === 'acp' && m.sandbox !== undefined && m.sandbox.backend !== 'none'
    ? m.sandbox
    : undefined;
}

/**
 * What a connector process takes from the daemon's environment beyond the MCP SDK's default
 * set: the proxy, CA, locale and zone variables a client needs to reach the network and
 * format time. `LC_*` is matched by prefix.
 */
const PASSED_THROUGH = new Set([
  'TZ',
  'LANG',
  'LANGUAGE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

/**
 * A connector process's base environment, picked from `env` (the daemon's, scrubbed): the
 * MCP SDK's default set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) and
 * `PASSED_THROUGH`. Like the SDK, it skips a value that is a shell function.
 */
export function connectorBaseEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const wanted =
      DEFAULT_INHERITED_ENV_VARS.includes(k) || PASSED_THROUGH.has(k) || k.startsWith('LC_');
    if (wanted && !v.startsWith('()')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A connector process's environment, secrets rendered (docs/internal/connectors.md): the base
 * environment, the manifest's `env`, `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and
 * `OA_CONFIG_JSON`. An acp agent gets the manifest's `env` and its name but no
 * `OA_CORE_SOCKET` and no `OA_CONFIG_JSON`: it runs sessions, not ops, and a sandboxed one
 * cannot reach the socket anyway. A sandboxed agent gets no base environment either (bwrap
 * clears it and sets `PATH`, `HOME` and, when the daemon has one, `LANG` itself); `OA_HOME`
 * is passed through when the base environment carries it, so bundled launchers still
 * resolve. `${env.X}` in the manifest renders from `templateEnv`, the daemon's scrubbed
 * environment, as in a task. Shared by the supervisor and `247-agent-connector-host`.
 */
export function connectorChildEnv(opts: {
  manifest: ConnectorConfig;
  secrets: SecretsBackend;
  baseEnv: Record<string, string>;
  templateEnv: Readonly<Record<string, string>>;
  socketPath: string;
}): Record<string, string> {
  const { manifest, baseEnv } = opts;
  const refs = collectTemplateRefs({ config: manifest.config, env: manifest.env });
  const secrets = opts.secrets.resolve(refs.secrets);
  const scope = { secrets, env: opts.templateEnv };
  const env = renderValue(manifest.env, scope) as Record<string, string>;
  if (manifest.transport === 'acp') {
    const home = baseEnv.OA_HOME;
    const base =
      sandboxOf(manifest) === undefined ? baseEnv : home === undefined ? {} : { OA_HOME: home };
    return { ...base, ...env, OA_CONNECTOR_NAME: manifest.name };
  }
  const config = renderValue(manifest.config, scope);
  return {
    ...baseEnv,
    ...env,
    OA_CORE_SOCKET: opts.socketPath,
    OA_CONNECTOR_NAME: manifest.name,
    OA_CONFIG_JSON: JSON.stringify(config),
  };
}
