import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { isInside } from '../config/crosscheck.js';
import { errorMessage } from '../errors.js';
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

/** The largest result file the runner reads; a bigger one fails the attempt. */
export const MAX_RESULT_BYTES = 1024 * 1024;

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
        `result.schema is not a usable JSON Schema: ${errorMessage(err)}`,
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

function invalid(error: string): ReadResult {
  return { ok: false, missing: false, error };
}

/**
 * The file's text, read only when it is a regular file whose real directory is inside the
 * real workspace: the agent may have planted a symlink (to a file its sandbox hides, or a
 * directory outside the workspace), a FIFO that would block the read, or a huge file.
 * Nothing of a refused file is read, so its content never reaches the run error or the
 * retry prompt.
 */
function readRegularFile(workspace: string, path: string, relative: string): string | ReadResult {
  let fd: number;
  try {
    if (!isInside(realpathSync(workspace), realpathSync(dirname(path)))) {
      return invalid(`${relative} is outside the workspace`);
    }
    // O_NOFOLLOW refuses a symlink as the last component; O_NONBLOCK keeps a FIFO from
    // blocking the open until fstat refuses it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, missing: true };
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      return invalid(`${relative} is not a regular file`);
    }
    return invalid(`cannot read ${relative}: ${errorMessage(err)}`);
  }
  try {
    const st = fstatSync(fd);
    // A hard link can name a file outside the workspace; an agent's own file has one name.
    if (!st.isFile() || st.nlink > 1) {
      return invalid(`${relative} is not a regular file`);
    }
    // The open went by path, so a directory swapped for a symlink after the check above
    // could have led it outside. Re-resolve the directory and require the same file there.
    const realDir = realpathSync(dirname(path));
    const there = lstatSync(join(realDir, basename(path)), { throwIfNoEntry: false });
    if (
      !isInside(realpathSync(workspace), realDir) ||
      there?.dev !== st.dev ||
      there.ino !== st.ino
    ) {
      return invalid(`${relative} is outside the workspace`);
    }
    const tooLarge = invalid(`${relative} is larger than ${String(MAX_RESULT_BYTES)} bytes`);
    if (st.size > MAX_RESULT_BYTES) {
      return tooLarge;
    }
    // Read one byte past the limit, so a file that grew after fstat is still refused.
    const buf = Buffer.alloc(MAX_RESULT_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) {
        break;
      }
      n += got;
      if (n > MAX_RESULT_BYTES) {
        return tooLarge;
      }
    }
    return buf.toString('utf8', 0, n);
  } catch (err) {
    return invalid(`cannot read ${relative}: ${errorMessage(err)}`);
  } finally {
    closeSync(fd);
  }
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
  const read = readRegularFile(workspace, path, relative);
  if (typeof read !== 'string') {
    return read;
  }
  const text = read;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    // V8's message quotes the start of the text; keep only where parsing stopped.
    const at = /position \d+/.exec(err instanceof Error ? err.message : '');
    return invalid(`${relative} is not JSON${at === null ? '' : ` (at ${at[0]})`}`);
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
