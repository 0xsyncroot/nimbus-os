// aggregator.ts — SPEC-701 T5: in-memory rollup with 5-minute cache.

import { listMonths, monthKey, readMonth } from './ledger.ts';
import type { AggregateWindow, CostEvent, CostRollup } from './types.ts';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  rollup: CostRollup;
}

const cache = new Map<string, CacheEntry>();

function dayKey(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function windowStart(window: AggregateWindow, now = Date.now()): number {
  const d = new Date(now);
  if (window === 'today') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (window === 'week') {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return start - 6 * 86_400_000;
  }
  // month = last 30 days rolling
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return start - 29 * 86_400_000;
}

function monthsToRead(window: AggregateWindow, now = Date.now()): string[] {
  const start = windowStart(window, now);
  const months = new Set<string>();
  // Walk day by day — cheap at ≤30 iterations.
  for (let t = start; t <= now; t += 86_400_000) months.add(monthKey(t));
  months.add(monthKey(now));
  return [...months].sort();
}

export async function aggregate(
  workspaceId: string,
  window: AggregateWindow,
  opts: { now?: number; bypassCache?: boolean } = {},
): Promise<CostRollup> {
  const now = opts.now ?? Date.now();
  const cacheKey = `${workspaceId}::${window}`;
  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.rollup;
  }

  const start = windowStart(window, now);
  const months = monthsToRead(window, now);
  const all: CostEvent[] = [];
  for (const m of months) {
    const evs = await readMonth(workspaceId, m);
    for (const e of evs) if (e.ts >= start && e.ts <= now) all.push(e);
  }
  const rollup = rollupEvents(all);
  cache.set(cacheKey, { rollup, expiresAt: now + CACHE_TTL_MS });
  return rollup;
}

export function rollupEvents(events: CostEvent[]): CostRollup {
  const rollup: CostRollup = {
    totalUsd: 0,
    byProvider: {},
    bySession: {},
    byDay: {},
    events: events.length,
  };
  for (const ev of events) {
    rollup.totalUsd += ev.costUsd;
    rollup.byProvider[ev.provider] = (rollup.byProvider[ev.provider] ?? 0) + ev.costUsd;
    rollup.bySession[ev.sessionId] = (rollup.bySession[ev.sessionId] ?? 0) + ev.costUsd;
    const d = dayKey(ev.ts);
    rollup.byDay[d] = (rollup.byDay[d] ?? 0) + ev.costUsd;
  }
  rollup.totalUsd = round6(rollup.totalUsd);
  for (const k of Object.keys(rollup.byProvider)) rollup.byProvider[k] = round6(rollup.byProvider[k]!);
  for (const k of Object.keys(rollup.bySession)) rollup.bySession[k] = round6(rollup.bySession[k]!);
  for (const k of Object.keys(rollup.byDay)) rollup.byDay[k] = round6(rollup.byDay[k]!);
  return rollup;
}

export async function listKnownMonths(workspaceId: string): Promise<string[]> {
  return listMonths(workspaceId);
}

export function __clearAggregatorCache(): void {
  cache.clear();
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
