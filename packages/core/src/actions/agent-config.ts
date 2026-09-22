import { z } from 'zod';

import { Budget } from '../llm/config.js';

const NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * `defaults.agent` in agent.yaml (ARCHITECTURE §7): what an `agent` action falls back to.
 * `work_dir` is resolved by `parseAgent` (default `<db dir>/work`); runs get
 * `<work_dir>/<run_id>` as their workspace.
 */
export const AgentDefaults = z
  .strictObject({
    /** The acp connector to run on when the action names none. */
    connector: z.string().regex(NAME, 'connector names are [a-z][a-z0-9_-]*').optional(),
    /** Tool calls the core allows in one run before it cancels the session. */
    max_tool_calls: z.number().int().positive().default(40),
    budget: Budget.optional(),
    work_dir: z.string().min(1).optional(),
  })
  .prefault({});

export type AgentDefaultsConfig = z.infer<typeof AgentDefaults>;
