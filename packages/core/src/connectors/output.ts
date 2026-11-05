/**
 * Connector output in the daemon log: each line of a child's stdout/stderr becomes a
 * `connector.output` entry, bounded in length and in rate so that a chatty or broken
 * connector cannot flood the log or grow the core's memory (#91).
 */
import { StringDecoder } from 'node:string_decoder';

import type { Logger } from '../log.js';

/** Characters of one line kept and logged; the rest is counted and dropped. */
export const MAX_LINE_CHARS = 2000;
/** Lines logged per connector process and window; the rest are counted and dropped. */
export const OUTPUT_LINES_PER_WINDOW = 100;
export const OUTPUT_WINDOW_MS = 10_000;

/**
 * Splits text into lines (`\n`, an `\r` before it removed) and keeps at most `max`
 * characters of the line in progress, however long it grows without a newline.
 */
export class LineReader {
  private buf = '';
  private chars = 0;
  /** Whether the last character taken was `\r`, which a following `\n` drops. */
  private cr = false;

  constructor(
    private readonly max: number,
    private readonly onLine: (line: string, chars: number) => void,
  ) {}

  /** Characters of the unterminated line held in memory (at most `max`). */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: string): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl === -1) {
        this.take(chunk.slice(start));
        return;
      }
      this.take(chunk.slice(start, nl));
      this.flush();
      start = nl + 1;
    }
  }

  /** Emits the unterminated last line, if any. */
  end(): void {
    if (this.chars > 0) {
      this.flush();
    }
  }

  private take(part: string): void {
    if (part.length > 0) {
      this.cr = part.endsWith('\r');
    }
    this.chars += part.length;
    if (this.buf.length < this.max) {
      this.buf += part.slice(0, this.max - this.buf.length);
    }
  }

  private flush(): void {
    let line = this.buf;
    let chars = this.chars;
    if (this.cr) {
      chars--;
      line = line.slice(0, chars); // the `\r` is kept only when the line fit
    }
    this.buf = '';
    this.chars = 0;
    this.cr = false;
    this.onLine(line, chars);
  }
}

export interface OutputLimiterOptions {
  lines?: number;
  windowMs?: number;
  clock?: () => number;
  /** Called for every line dropped by the rate limit (a metric). */
  onDrop?: (lines: number) => void;
}

/**
 * A fixed-window line budget, shared by every stream of one process. Lines past the
 * budget are counted; the count is logged once at `warn` as `connector.output_dropped`
 * before the next line that fits, at the end of the window, or when a stream ends.
 */
export class OutputLimiter {
  private readonly lines: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly onDrop: ((lines: number) => void) | undefined;
  private windowStart = -Infinity;
  private used = 0;
  private dropped = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: OutputLimiterOptions = {}) {
    this.lines = opts.lines ?? OUTPUT_LINES_PER_WINDOW;
    this.windowMs = opts.windowMs ?? OUTPUT_WINDOW_MS;
    this.clock = opts.clock ?? Date.now;
    this.onDrop = opts.onDrop;
  }

  /** True when the line may be logged; reports earlier drops to `log` first. */
  allow(log: Logger): boolean {
    const now = this.clock();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= this.lines) {
      this.dropped++;
      this.onDrop?.(1);
      // Reported with the next line that fits, or at the end of the window if none comes.
      this.timer ??= setTimeout(
        () => {
          this.report(log);
        },
        Math.max(0, this.windowStart + this.windowMs - now),
      ).unref();
      return false;
    }
    this.report(log);
    this.used++;
    return true;
  }

  /** Logs the lines dropped since the last report, if any. */
  report(log: Logger): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dropped > 0) {
      log.warn('connector.output_dropped', {
        lines: this.dropped,
        limit: this.lines,
        window_ms: this.windowMs,
      });
      this.dropped = 0;
    }
  }
}

/**
 * Logs each line of a child's stream as `connector.output`, through `limiter` (one per
 * process, so its streams share the budget). Resolves when the stream has ended.
 */
export function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  name: string,
  log: Logger,
  limiter: OutputLimiter = new OutputLimiter(),
): Promise<void> {
  if (stream === null || stream === undefined) {
    return Promise.resolve();
  }
  const decoder = new StringDecoder('utf8');
  const reader = new LineReader(MAX_LINE_CHARS, (line, chars) => {
    if (!limiter.allow(log)) {
      return;
    }
    log.info('connector.output', {
      stream: name,
      line,
      ...(chars > line.length ? { truncated: true, chars } : {}),
    });
  });
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      reader.push(decoder.end());
      reader.end();
      limiter.report(log);
      resolve();
    };
    stream.on('data', (chunk: Buffer | string) => {
      reader.push(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', () => undefined);
  });
}
