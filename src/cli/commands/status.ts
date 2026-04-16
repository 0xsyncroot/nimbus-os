// status.ts — SPEC-603: `nimbus status` — 1-line overview: OK | last error | today cost.

import { streamShards, metricsDir, parseSince } from '../../observability/reader.ts';

function todayStartMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export async function runStatus(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const sinceMs = todayStartMs();

  let lastError: string | null = null;
  let todayCostUsd = 0;
  let hasEvents = false;

  for await (const line of streamShards(metricsDir(), { since: sinceMs })) {
    hasEvents = true;
    const obj = line as Record<string, unknown>;
    if (obj['type'] === 'error' || obj['type'] === 'turn_complete') {
      if (obj['ok'] === false && typeof obj['code'] === 'string') {
        lastError = obj['code'] as string;
      }
    }
    if (obj['type'] === 'usage' && typeof obj['costUsd'] === 'number') {
      todayCostUsd += obj['costUsd'] as number;
    }
  }

  const overall = lastError ? 'degraded' : 'ok';
  const costStr = `$${todayCostUsd.toFixed(4)}`;

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ overall, lastError, todayCostUsd, hasEvents }) + '\n',
    );
    return overall === 'ok' ? 0 : 1;
  }

  if (!hasEvents) {
    process.stdout.write('nimbus status: OK (no events today)\n');
    return 0;
  }

  if (lastError) {
    process.stdout.write(`nimbus status: DEGRADED | last error: ${lastError} | today cost: ${costStr}\n`);
    return 1;
  }

  process.stdout.write(`nimbus status: OK | today cost: ${costStr}\n`);
  return 0;
}

export function parseSinceArg(args: string[]): number {
  const idx = args.indexOf('--since');
  if (idx >= 0 && args[idx + 1]) return parseSince(args[idx + 1]!);
  return Date.now() - 24 * 60 * 60 * 1000;
}
