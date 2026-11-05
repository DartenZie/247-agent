import { z } from 'zod';

import type { JsonValue } from '../store/types.js';

/** The value types a manual task's param can declare. */
export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** A value a param accepts, or why it does not. */
export type ParamCheck = { ok: true; value: JsonValue } | { ok: false; message: string };

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return `string ${JSON.stringify(value)}`;
    case 'number':
    case 'boolean':
      return `${typeof value} ${String(value)}`;
    default:
      return typeof value;
  }
}

function hasType(type: ParamType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

/** `oa run -p age=36` sends a string: read it as the declared type when it is one. */
function fromString(type: ParamType, text: string): unknown {
  switch (type) {
    case 'string':
      return text;
    case 'number':
    case 'integer':
      return text.trim() === '' ? text : Number(text);
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text;
    case 'object':
    case 'array':
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
  }
}

/**
 * Checks one value against a param's type and enum. With `convert`, a string is first read
 * as the declared type (`"36"` for an integer); a value that still does not fit is
 * reported as it was given.
 */
export function checkParamValue(
  spec: { type: ParamType; enum?: readonly JsonValue[] | undefined },
  value: unknown,
  convert = false,
): ParamCheck {
  const read = convert && typeof value === 'string' ? fromString(spec.type, value) : value;
  if (!hasType(spec.type, read)) {
    return { ok: false, message: `expected ${spec.type}, got ${describe(value)}` };
  }
  if (spec.enum !== undefined) {
    const key = JSON.stringify(read);
    if (!spec.enum.some((e) => JSON.stringify(e) === key)) {
      const allowed = spec.enum.map((e) => JSON.stringify(e)).join(', ');
      return { ok: false, message: `expected one of ${allowed}, got ${key}` };
    }
  }
  return { ok: true, value: read as JsonValue };
}

const PARAM_NAME = /^[a-z][a-z0-9_]*$/;

/** One declared input of a manual task, read from `event.payload.<name>`. */
export const ManualParam = z
  .strictObject({
    type: z.enum(PARAM_TYPES).default('string'),
    description: z.string().min(1).optional(),
    /** Default: true, unless the param has a `default`. */
    required: z.boolean().optional(),
    default: z.json().optional(),
    enum: z.array(z.json()).min(1).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.required === true && p.default !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['required'],
        message: 'a param with a default is not required; drop one of them',
      });
    }
    p.enum?.forEach((value, i) => {
      const r = checkParamValue({ type: p.type }, value);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', path: ['enum', i], message: r.message });
      }
    });
    if (p.default !== undefined) {
      const r = checkParamValue(p, p.default);
      if (!r.ok) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: r.message });
      }
    }
  });
export type ManualParam = z.infer<typeof ManualParam>;

export const ManualParams = z.record(
  z.string().regex(PARAM_NAME, 'a param name is lower case letters, digits and _'),
  ManualParam,
);
export type ManualParams = z.infer<typeof ManualParams>;

/** One problem with the params of a manual run; `path` is the param name, empty for the whole. */
export interface ParamIssue {
  path: string;
  message: string;
}

/**
 * Validates a manual run's payload against the declared params: every required param is
 * present, every value fits its type and enum (strings are converted), no undeclared key.
 * Returns the payload with defaults filled in, or every issue found.
 */
export function applyParams(
  params: ManualParams,
  payload: JsonValue | undefined,
): { ok: true; payload: Record<string, JsonValue> } | { ok: false; issues: ParamIssue[] } {
  const given = payload ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) {
    return {
      ok: false,
      issues: [{ path: '', message: `parameters must be an object, got ${describe(given)}` }],
    };
  }
  const issues: ParamIssue[] = [];
  const out: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(params)) {
    const value = given[name];
    if (value === undefined) {
      if (spec.default !== undefined) {
        out[name] = spec.default;
      } else if (spec.required !== false) {
        issues.push({ path: name, message: 'required parameter is missing' });
      }
      continue;
    }
    const r = checkParamValue(spec, value, true);
    if (r.ok) {
      out[name] = r.value;
    } else {
      issues.push({ path: name, message: r.message });
    }
  }
  const declared = Object.keys(params);
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(params, name)) {
      issues.push({
        path: name,
        message:
          declared.length === 0
            ? 'unknown parameter; the task declares none'
            : `unknown parameter; declared: ${declared.join(', ')}`,
      });
    }
  }
  return issues.length === 0 ? { ok: true, payload: out } : { ok: false, issues };
}
