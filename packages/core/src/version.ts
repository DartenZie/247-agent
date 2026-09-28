/**
 * The daemon's version, printed by `247-agent-core --version` and `oa --version` and sent
 * as the MCP client version to connectors. Kept in step with the root `package.json` by
 * `version.test.ts`; bump both together (release tags are `v<version>`).
 */
export const VERSION = '0.1.0';
