import type { EventRecord, RunRecord, TranscriptEntry } from '@247-agent/core';

/** Seconds between two ISO timestamps as `3.2s`, `1m05s`, or `-` when either is missing. */
export function took(from: string | null, to: string | null): string {
  if (from === null || to === null) {
    return '-';
  }
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) {
    return '-';
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  return `${String(m)}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function firstLine(text: string | null, n: number): string {
  return text === null ? '' : clip(text.replace(/\s+/g, ' ').trim(), n);
}

/** One line per run: id, task, status, created, duration, error. */
export function runLine(r: RunRecord, width: number): string {
  const error = r.error === null ? '' : `  ${firstLine(r.error, 80)}`;
  return `${r.id}  ${r.task.padEnd(width)}  ${r.status.padEnd(9)}  ${r.created_at}  ${took(r.started_at, r.finished_at).padStart(7)}${error}`;
}

/** One line per event: seq, id, ts, type, source, correlation. */
export function eventLine(e: EventRecord): string {
  const parent = e.parent_id === null ? '' : `  parent=${e.parent_id}`;
  return `${e.ts}  ${e.id}  ${e.type}  source=${e.source}  correlation=${e.correlation_id}${parent}`;
}

function field(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** A transcript entry as `oa runs logs` prints it: a header line, then the text indented. */
export function transcriptLines(e: TranscriptEntry): string[] {
  const head = `${e.ts}  turn ${String(e.turn)}  ${e.kind}`;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const text = e.text === null ? [] : e.text.split('\n').map((l) => `    ${l}`);
  switch (e.kind) {
    case 'prompt':
    case 'text':
    case 'thought':
      return [head, ...text];
    case 'tool_call': {
      const command = field(d, 'command');
      const locations = Array.isArray(d.locations) ? (d.locations as string[]) : [];
      return [
        `${head}  ${field(d, 'id') ?? ''}  ${field(d, 'tool_kind') ?? ''}  ${JSON.stringify(field(d, 'title') ?? '')}` +
          (command === undefined ? '' : `  cmd=${JSON.stringify(command)}`) +
          (locations.length === 0 ? '' : `  at=${locations.join(' ')}`) +
          `  ${field(d, 'status') ?? ''}`,
      ];
    }
    case 'tool_call_update': {
      const command = field(d, 'command');
      return [
        `${head}  ${field(d, 'id') ?? ''}  ${field(d, 'status') ?? '-'}` +
          (command === undefined ? '' : `  cmd=${JSON.stringify(command)}`),
      ];
    }
    case 'permission': {
      const reason = field(d, 'reason');
      return [
        `${head}  ${field(d, 'id') ?? ''}  ${d.allowed === true ? 'allowed' : 'refused'}` +
          (reason === undefined ? '' : `  ${reason}`),
      ];
    }
    case 'usage':
      return [
        `${head}  context=${field(d, 'used') ?? '?'}/${field(d, 'size') ?? '?'}` +
          (typeof d.cost_usd === 'number' ? `  cost_usd=${d.cost_usd.toFixed(4)}` : ''),
      ];
    case 'stop':
      return [
        `${head}  ${field(d, 'stop_reason') ?? ''}  in=${field(d, 'input_tokens') ?? '-'}  out=${field(d, 'output_tokens') ?? '-'}`,
      ];
    case 'cancel': {
      const detail = field(d, 'detail');
      return [`${head}  ${field(d, 'reason') ?? ''}${detail === undefined ? '' : `  ${detail}`}`];
    }
    case 'result':
      return [`${head}  ${field(d, 'status') ?? ''}  ${JSON.stringify(field(d, 'summary') ?? '')}`];
  }
}
