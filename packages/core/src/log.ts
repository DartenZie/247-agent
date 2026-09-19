export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Scalars only. Payloads (and therefore secrets) cannot be logged by type; put ids in the
 * log and look the rest up in the store.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` (e.g. run_id, task, correlation_id) to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  sink?: (line: string) => void;
  level?: LogLevel;
  base?: LogFields;
  clock?: () => Date;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultSink = (line: string): void => {
  process.stdout.write(line + '\n');
};

function build(
  sink: (line: string) => void,
  threshold: number,
  base: LogFields,
  clock: () => Date,
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVELS[level] < threshold) {
      return;
    }
    const line: Record<string, unknown> = { ts: clock().toISOString(), level, msg, ...base };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) {
          line[k] = v;
        }
      }
    }
    sink(JSON.stringify(line));
  };
  return {
    debug: (msg, fields) => {
      emit('debug', msg, fields);
    },
    info: (msg, fields) => {
      emit('info', msg, fields);
    },
    warn: (msg, fields) => {
      emit('warn', msg, fields);
    },
    error: (msg, fields) => {
      emit('error', msg, fields);
    },
    child: (fields) => build(sink, threshold, { ...base, ...fields }, clock),
  };
}

/** Structured JSON-lines logger. One object per line: `{ts, level, msg, ...fields}`. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  return build(
    opts.sink ?? defaultSink,
    LEVELS[opts.level ?? 'info'],
    opts.base ?? {},
    opts.clock ?? (() => new Date()),
  );
}

/** A logger that drops everything; handy as a default in tests. */
export const nullLogger: Logger = createLogger({ sink: () => undefined, level: 'error' });
