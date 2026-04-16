// metrics.ts — SPEC-603: `nimbus metrics [--since 1h|1d]` — p50/p95/p99 + tokens + cost.

import { computeRollup } from '../../observability/rollup.ts';
import { parseSince } from '../../observability/reader.ts';

export async function runMetrics(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const sinceIdx = args.indexOf('--since');
  const sinceStr = sinceIdx >= 0 ? args[sinceIdx + 1] : '1d';
  const sinceMs = parseSince(sinceStr ?? '1d');

  const results = await computeRollup(sinceMs);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results) + '\n');
    return 0;
  }

  if (results.length === 0) {
    process.stdout.write('nimbus metrics: no usage data found\n');
    return 0;
  }

  process.stdout.write(`nimbus metrics (since ${new Date(sinceMs).toISOString()})\n`);
  process.stdout.write(`${'provider/model'.padEnd(30)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'p99'.padStart(6)} ${'tokens-in'.padStart(10)} ${'tokens-out'.padStart(10)} ${'cost'.padStart(10)}\n`);
  process.stdout.write(`${'-'.repeat(84)}\n`);

  for (const r of results) {
    const key = `${r.provider}/${r.model}`.slice(0, 29);
    const lat = r.latency;
    const tok = r.tokens;
    process.stdout.write(
      `${key.padEnd(30)} ${String(lat.p50).padStart(6)} ${String(lat.p95).padStart(6)} ${String(lat.p99).padStart(6)} ${String(tok.inputTokens).padStart(10)} ${String(tok.outputTokens).padStart(10)} $${tok.costUsd.toFixed(4).padStart(9)}\n`,
    );
  }
  return 0;
}
