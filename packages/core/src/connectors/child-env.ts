/**
 * A connector process's environment, shared by the supervisor (a child of the daemon) and
 * `247-agent-connector-host` (a `managed_by: systemd` unit). Kept apart from the supervisor
 * so the host's bundle does not pull in the ACP client, execa and the tool bridge.
 */
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
 * A connector process's environment, secrets rendered (ARCHITECTURE §6): the base
 * environment, the manifest's `env`, `OA_CORE_SOCKET`, `OA_CONNECTOR_NAME` and
 * `OA_CONFIG_JSON`. An acp agent gets the manifest's `env` and its name but no
 * `OA_CORE_SOCKET` and no `OA_CONFIG_JSON`: it runs sessions, not ops, and a sandboxed one
 * cannot reach the socket anyway. A sandboxed agent gets no base environment either (bwrap
 * clears it and sets `PATH`, `HOME` and `LANG` itself); `OA_HOME` is kept so bundled
 * launchers still resolve. Shared by the supervisor and `247-agent-connector-host`.
 */
export function connectorChildEnv(opts: {
  manifest: ConnectorConfig;
  secrets: SecretsBackend;
  baseEnv: Record<string, string>;
  socketPath: string;
}): Record<string, string> {
  const { manifest, baseEnv } = opts;
  const refs = collectTemplateRefs({ config: manifest.config, env: manifest.env });
  const secrets = opts.secrets.resolve(refs.secrets);
  const scope = { secrets, env: baseEnv };
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
