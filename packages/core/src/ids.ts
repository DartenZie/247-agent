import { randomBytes } from 'node:crypto';

export type IdPrefix = 'evt' | 'run' | 'cor';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_CHARS = 10; // 48 bits of ms timestamp
const RANDOM_CHARS = 16; // 80 bits of randomness

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  let out = '';
  for (const byte of randomBytes(RANDOM_CHARS)) {
    out += ALPHABET.charAt(byte % 32);
  }
  return out;
}

/**
 * Time-sortable id in ULID format (10 time chars + 16 random chars, Crockford base32) with a
 * type prefix, e.g. `evt_01J8Z3ABCDEFGHJKMNPQRSTVWX`. Ordering is only guaranteed at
 * millisecond resolution; the store's `seq` column is the ordering authority.
 */
export function newId(prefix: IdPrefix, now: Date = new Date()): string {
  return `${prefix}_${encodeTime(now.getTime())}${encodeRandom()}`;
}
