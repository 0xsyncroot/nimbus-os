// webSearch/cache.ts — SPEC-305 T6: file-backed LRU cache, TTL 1h, 500-entry cap, 10MB cap.

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { WebSearchOutput } from './types.ts';

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB

interface CacheEntry {
  key: string;
  data: WebSearchOutput;
  ts: number;        // creation time ms
  accessTs: number;  // last access time ms (for LRU)
  byteSize: number;
}

interface CacheState {
  dir: string;
  /** In-memory LRU tracking: ordered from oldest to newest access */
  order: string[]; // keys
  totalBytes: number;
}

let state: CacheState | null = null;

function getDir(): string {
  return (
    process.env['NIMBUS_SEARCH_CACHE_DIR'] ??
    join(process.env['NIMBUS_HOME'] ?? join(process.env['HOME'] ?? '/tmp', '.nimbus'), 'search-cache')
  );
}

function ensureState(): CacheState {
  if (state) return state;
  const dir = getDir();
  mkdirSync(dir, { recursive: true });
  // Scan existing entries to rebuild in-memory order by access time.
  const order: string[] = [];
  let totalBytes = 0;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const entries: Array<{ key: string; accessTs: number; byteSize: number }> = [];
    for (const file of files) {
      const key = file.slice(0, -5);
      try {
        const stat = statSync(join(dir, file));
        const raw = readFileSync(join(dir, file), 'utf-8');
        const parsed = JSON.parse(raw) as CacheEntry;
        entries.push({ key, accessTs: parsed.accessTs ?? stat.mtimeMs, byteSize: parsed.byteSize ?? raw.length });
        totalBytes += parsed.byteSize ?? raw.length;
      } catch {
        // Corrupt entry — skip.
      }
    }
    entries.sort((a, b) => a.accessTs - b.accessTs);
    for (const e of entries) order.push(e.key);
  } catch {
    // Dir empty or read error — start fresh.
  }
  state = { dir, order, totalBytes };
  return state;
}

export function cacheKey(provider: string, query: string, maxResults: number, dateRange?: string): string {
  return createHash('sha256')
    .update(`${provider}\0${query}\0${maxResults}\0${dateRange ?? ''}`)
    .digest('hex');
}

export function cacheGet(key: string): WebSearchOutput | null {
  const s = ensureState();
  const filePath = join(s.dir, `${key}.json`);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.ts > TTL_MS) {
      // Expired — evict.
      cacheEvictKey(key);
      return null;
    }
    // Update LRU order + access time.
    entry.accessTs = Date.now();
    writeFileSync(filePath, JSON.stringify(entry), 'utf-8');
    const idx = s.order.indexOf(key);
    if (idx !== -1) s.order.splice(idx, 1);
    s.order.push(key);
    return entry.data;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, data: WebSearchOutput): void {
  const s = ensureState();
  const now = Date.now();
  const entry: CacheEntry = { key, data, ts: now, accessTs: now, byteSize: 0 };
  const serialized = JSON.stringify(entry);
  entry.byteSize = Buffer.byteLength(serialized, 'utf-8');
  const final = JSON.stringify(entry);
  const byteSize = Buffer.byteLength(final, 'utf-8');

  // Evict until within caps.
  while (
    s.order.length >= MAX_ENTRIES ||
    s.totalBytes + byteSize > MAX_TOTAL_BYTES
  ) {
    const oldest = s.order[0];
    if (!oldest) break;
    cacheEvictKey(oldest);
  }

  writeFileSync(join(s.dir, `${key}.json`), final, 'utf-8');
  const existing = s.order.indexOf(key);
  if (existing !== -1) s.order.splice(existing, 1);
  s.order.push(key);
  s.totalBytes += byteSize;
}

function cacheEvictKey(key: string): void {
  const s = ensureState();
  try {
    const filePath = join(s.dir, `${key}.json`);
    const raw = readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    s.totalBytes = Math.max(0, s.totalBytes - (entry.byteSize ?? 0));
    unlinkSync(filePath);
  } catch {
    // Already gone.
  }
  const idx = s.order.indexOf(key);
  if (idx !== -1) s.order.splice(idx, 1);
}

/** Test-only: reset in-memory state so a new dir can be used. */
export function __resetSearchCacheState(): void {
  state = null;
}
