import type { OutputStream, RunOutput } from '../actions/types.js';
import { redact, redactions } from '../secrets/redact.js';

/** Characters of each stream an attempt keeps; a cut tail starts with `…`. */
export const OUTPUT_TAIL_CHARS = 4096;

const CUT = '…';

export interface OutputSnapshot {
  stdout: string | null;
  stderr: string | null;
}

/**
 * The tail of what an attempt's action printed, per stream (`ctx.output`). It buffers at
 * most a few times the cap, plus the longest secret, so a chatty command costs bounded
 * memory. Secret values are replaced on the whole buffer at `snapshot()`, before the cut:
 * a secret split across two writes, or one that straddles the cut, is still redacted.
 */
export class OutputTail implements RunOutput {
  private readonly buf: Record<OutputStream, string>;
  private secrets: [string, string][] = [];
  private keep = OUTPUT_TAIL_CHARS;

  /** `seed`: what an earlier pass of the same attempt stored (a resume after a wait). */
  constructor(seed: OutputSnapshot = { stdout: null, stderr: null }) {
    this.buf = { stdout: seed.stdout ?? '', stderr: seed.stderr ?? '' };
  }

  /** The run's resolved secrets, by name; replaced as in transcripts (`[secret:<name>]`). */
  addSecrets(secrets: Readonly<Record<string, string>>): void {
    this.secrets = redactions(secrets);
    // Enough that every secret starting in the kept tail is still whole in the buffer.
    this.keep = OUTPUT_TAIL_CHARS + (this.secrets[0]?.[0].length ?? 0);
  }

  write(stream: OutputStream, text: string): void {
    const next = this.buf[stream] + text;
    // Redacted before the trim, so the trim never leaves a fragment of a secret at the start;
    // a secret still being written at the end is not whole yet and is left for later.
    this.buf[stream] = next.length > 2 * this.keep ? this.redact(next).slice(-this.keep) : next;
  }

  /** Characters held across both streams (a test seam for the memory bound). */
  bufferedChars(): number {
    return this.buf.stdout.length + this.buf.stderr.length;
  }

  snapshot(): OutputSnapshot {
    return { stdout: this.render('stdout'), stderr: this.render('stderr') };
  }

  private render(stream: OutputStream): string | null {
    if (this.buf[stream] === '') {
      return null;
    }
    const text = this.redact(this.buf[stream]);
    return text.length <= OUTPUT_TAIL_CHARS
      ? text
      : CUT + text.slice(-(OUTPUT_TAIL_CHARS - CUT.length));
  }

  private redact(text: string): string {
    return redact(text, this.secrets);
  }
}
