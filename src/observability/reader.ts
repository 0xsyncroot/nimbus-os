// reader.ts — SPEC-603: streaming JSONL reader with --since filter.
// Line-by-line streaming (no full-file load). Day-shard aware.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { logsDir } from '../platform/paths.ts';
import { logger } from './logger.ts';

export interface ReaderOpts {
  since?: number;   // epoch ms — only return lines with ts >= since
  until?: number;   // epoch ms — only return lines with ts <= until
  filter?: (line: unknown) => boolean;
}

export function metricsDir(): string {
  return join(logsDir(), 'metrics');
}

function parseDate(filename: string): Date | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m || !m[1]) return null;
  return new Date(m[1] + 'T00:00:00.000Z');
}

export async function listShards(dir: string, since?: number): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const sorted = files
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  if (since === undefined) return sorted.map((f) => join(dir, f));

  return sorted
    .filter((f) => {
      const d = parseDate(f);
      if (!d) return false;
      // Include shard if the day is >= since (midnight of that day)
      const dayEnd = d.getTime() + 86_400_000;
      return dayEnd >= since;
    })
    .map((f) => join(dir, f));
}

export async function* streamJsonl(filePath: string, opts: ReaderOpts = {}): AsyncIterable<unknown> {
  let exists = false;
  try {
    await stat(filePath);
    exists = true;
  } catch {
    // file doesn't exist — yield nothing
  }
  if (!exists) return;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.warn({ line: trimmed.slice(0, 120) }, 'jsonl reader: malformed line skipped');
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const ts = typeof obj['ts'] === 'number' ? (obj['ts'] as number) : undefined;
    if (ts !== undefined) {
      if (opts.since !== undefined && ts < opts.since) continue;
      if (opts.until !== undefined && ts > opts.until) continue;
    }
    if (opts.filter && !opts.filter(parsed)) continue;
    yield parsed;
  }
}

export async function* streamShards(dir: string, opts: ReaderOpts = {}): AsyncIterable<unknown> {
  const shards = await listShards(dir, opts.since);
  for (const shard of shards) {
    yield* streamJsonl(shard, opts);
  }
}

export function parseSince(s: string): number {
  const now = Date.now();
  if (s === '1h') return now - 60 * 60 * 1000;
  if (s === '6h') return now - 6 * 60 * 60 * 1000;
  if (s === '1d') return now - 24 * 60 * 60 * 1000;
  if (s === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (s === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  // ISO date or epoch ms
  const n = Number(s);
  if (!isNaN(n)) return n;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  return now - 24 * 60 * 60 * 1000; // default 1d
}
