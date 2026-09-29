/**
 * The `model` and `effort` of an `agent` action, applied to the session as ACP config
 * options (ARCHITECTURE §5.4) before the first prompt. Agents name their options freely
 * (claude-agent-acp `effort`, codex-acp `reasoning_effort`), so an option is found by its
 * protocol category: `model` and `thought_level`.
 */
import type { AgentConfigOption, AgentSession } from '../connectors/acp-types.js';
import type { Logger } from '../log.js';
import { NonRetryableError } from './types.js';

export interface SessionSettings {
  model?: string | undefined;
  effort?: string | undefined;
}

/** In the order they are set: a model switch can change the effort levels on offer. */
const SETTINGS = [
  { field: 'model', category: 'model' },
  { field: 'effort', category: 'thought_level' },
] as const;

function find(
  options: readonly AgentConfigOption[],
  category: string,
): AgentConfigOption | undefined {
  return options.find((o) => o.category === category && o.type === 'select');
}

function describe(options: readonly AgentConfigOption[]): string {
  return options.length === 0
    ? 'it reports no config options'
    : `its options: ${options.map((o) => `${o.id} (${o.category ?? 'no category'})`).join(', ')}`;
}

/**
 * Sets each given setting on the session. Fails non-retryably when the agent offers no
 * option of that category or refuses the value (the message lists what it offers). The
 * model may be an alias the agent resolves (claude-agent-acp maps `claude-opus-5` to its
 * picker entry); the effort must come back as sent. Logs `agent.config` with the session's
 * model and effort as they end up, set or not.
 */
export async function applySessionSettings(
  session: AgentSession,
  settings: SessionSettings,
  connector: string,
  log: Logger,
): Promise<void> {
  let options = session.configOptions;
  for (const { field, category } of SETTINGS) {
    const value = settings[field];
    if (value === undefined) {
      continue;
    }
    const option = find(options, category);
    if (option === undefined) {
      throw new NonRetryableError(
        `agent "${connector}" offers no ${category} config option to set ${field} "${value}"; ${describe(options)}`,
      );
    }
    try {
      options = await session.setConfigOption(option.id, value);
    } catch (err) {
      throw new NonRetryableError(
        `agent "${connector}" refused ${field} "${value}" (${err instanceof Error ? err.message : String(err)}); it offers ${option.values.join(', ')}`,
        { cause: err },
      );
    }
    const now = find(options, category)?.currentValue;
    if (field === 'effort' && now !== value) {
      throw new NonRetryableError(
        `agent "${connector}" left ${field} at "${String(now)}" after it was set to "${value}"`,
      );
    }
  }
  const current = (category: string): string | null => {
    const v = find(options, category)?.currentValue;
    return v === undefined ? null : String(v);
  };
  log.info('agent.config', { model: current('model'), effort: current('thought_level') });
}
