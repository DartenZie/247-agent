import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { isInside } from '../config/crosscheck.js';
import type { JsonValue } from '../store/types.js';
import { NonRetryableError } from './types.js';

/**
 * The RESULT.json contract (docs/internal/agent-action.md): what every agent run must leave in its
 * workspace. `status` is the deterministic outcome downstream `emit` rules route on:
 * `done` (the change is in the workspace; `post` gates run) or `blocked` (it could not be
 * done and `summary` says what is missing; gates are skipped, the run still succeeds).
 * A task's `result.schema` adds its own fields on top.
 */
export const BaselineResult = z.looseObject({
  status: z.enum(['done', 'blocked']),
  summary: z.string().min(1),
});

export type AgentResult = z.infer<typeof BaselineResult> & Record<string, JsonValue>;

export const DEFAULT_RESULT_PATH = 'RESULT.json';

/** What the runner appends to every prompt so the contract is stated, not assumed. */
export function resultInstructions(
  path: string,
  schema: Record<string, unknown> | undefined,
): string {
  const lines = [
    `When you are finished, write the file ${path} at the root of the working directory.`,
    'It must be a JSON object with at least:',
    '  "status": "done" when the requested change is complete in the working directory,',
    '            "blocked" when it cannot be completed (missing information, out of scope, refused);',
    '  "summary": one or two sentences for a human: what was done, or what is missing and why.',
    'Do not publish, push or deploy anything; a separate step does that.',
  ];
  if (schema !== undefined) {
    lines.push('The file must also satisfy this JSON Schema:', JSON.stringify(schema));
  }
  return lines.join('\n');
}

export type ReadResult =
  | { ok: true; result: AgentResult }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string };

const compiled = new Map<string, z.ZodType>();

/** Compiles a JSON Schema document once per distinct text. */
function schemaValidator(schema: Record<string, unknown>): z.ZodType {
  const key = JSON.stringify(schema);
  let v = compiled.get(key);
  if (v === undefined) {
    try {
      v = z.fromJSONSchema(schema);
    } catch (err) {
      throw new NonRetryableError(
        `result.schema is not a usable JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    compiled.set(key, v);
  }
  return v;
}

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) {
    return 'invalid';
  }
  const at = issue.path.map(String).join('.');
  return at === '' ? issue.message : `${at}: ${issue.message}`;
}

/**
 * Reads and validates the result file. `relative` must stay inside the workspace. A
 * missing file is reported as such (the runner nudges once); anything else invalid is an
 * error message for the run.
 */
export function readAgentResult(
  workspace: string,
  relative: string,
  schema: Record<string, unknown> | undefined,
): ReadResult {
  const path = resolve(workspace, relative);
  if (!isInside(workspace, path)) {
    throw new NonRetryableError(`result.path must stay inside the workspace: ${relative}`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, missing: true };
    }
    return {
      ok: false,
      missing: false,
      error: `cannot read ${relative}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      missing: false,
      error: `${relative} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const base = BaselineResult.safeParse(doc);
  if (!base.success) {
    return { ok: false, missing: false, error: `${relative}: ${firstIssue(base.error)}` };
  }
  if (schema !== undefined) {
    const r = schemaValidator(schema).safeParse(doc);
    if (!r.success) {
      return {
        ok: false,
        missing: false,
        error: `${relative} does not match result.schema: ${firstIssue(r.error)}`,
      };
    }
  }
  return { ok: true, result: base.data as AgentResult };
}
