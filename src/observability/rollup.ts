// rollup.ts — SPEC-603: histogram rollup + 5min cache.
// Uses a simple sorted-array p-percentile (no hdr-histogram-js dep needed for single-user scale).
// If hdr-histogram-js is added later, swap out percentile() only.

import { streamShards, metricsDir } from './reader.ts';

export interface HistogramSnapshot {
  p50: number;
  p95: number;
  p99: number;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface ProviderModelKey {
  provider: string;
  model: string;
}

export interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RollupResult {
  latency: HistogramSnapshot;
  tokens: TokenSummary;
  provider: string;
  model: string;
}

interface CacheEntry {
  results: RollupResult[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000; // 5min

let _cache: CacheEntry | null = null;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

export function buildHistogram(values: number[]): HistogramSnapshot {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0, sum: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    count: sorted.length,
    sum,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export async function computeRollup(sinceMs: number): Promise<RollupResult[]> {
  // Check cache
  if (_cache && _cache.expiresAt > Date.now()) {
    return _cache.results;
  }

  // Aggregate latency + tokens by provider:model
  const latencies = new Map<string, number[]>();
  const tokenMap = new Map<string, TokenSummary>();

  const dir = metricsDir();
  for await (const line of streamShards(dir, { since: sinceMs })) {
    const obj = line as Record<string, unknown>;
    if (obj['type'] !== 'usage') continue;
    const provider = typeof obj['provider'] === 'string' ? obj['provider'] : 'unknown';
    const model = typeof obj['model'] === 'string' ? obj['model'] : 'unknown';
    const key = `${provider}:${model}`;

    const input = typeof obj['input'] === 'number' ? (obj['input'] as number) : 0;
    const output = typeof obj['output'] === 'number' ? (obj['output'] as number) : 0;
    const ms = typeof obj['ms'] === 'number' ? (obj['ms'] as number) : undefined;
    const cost = typeof obj['costUsd'] === 'number' ? (obj['costUsd'] as number) : 0;

    if (ms !== undefined) {
      const arr = latencies.get(key) ?? [];
      arr.push(ms);
      latencies.set(key, arr);
    }

    const existing = tokenMap.get(key) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    existing.inputTokens += input;
    existing.outputTokens += output;
    existing.costUsd += cost;
    tokenMap.set(key, existing);
  }

  const results: RollupResult[] = [];
  const allKeys = new Set([...latencies.keys(), ...tokenMap.keys()]);
  for (const key of allKeys) {
    const [provider = 'unknown', model = 'unknown'] = key.split(':');
    const latVals = latencies.get(key) ?? [];
    const tok = tokenMap.get(key) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    results.push({
      provider,
      model,
      latency: buildHistogram(latVals),
      tokens: tok,
    });
  }

  _cache = { results, expiresAt: Date.now() + CACHE_TTL_MS };
  return results;
}

export function __resetRollupCache(): void {
  _cache = null;
}
