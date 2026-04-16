// errors.ts — SPEC-603: `nimbus errors [--since] [--code X_*]` — error count by code + circuit state.

import { streamShards, metricsDir, parseSince } from '../../observability/reader.ts';
import { getGlobalHealCircuit } from '../../selfHeal/circuit.ts';

interface ErrorSummary {
  code: string;
  count: number;
  lastOccurrence: number;
  circuitOpen: boolean;
}

export async function runErrors(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const sinceIdx = args.indexOf('--since');
  const sinceStr = sinceIdx >= 0 ? args[sinceIdx + 1] : '1d';
  const sinceMs = parseSince(sinceStr ?? '1d');

  const codeIdx = args.indexOf('--code');
  const filterCode = codeIdx >= 0 ? (args[codeIdx + 1] ?? null) : null;

  const counts = new Map<string, ErrorSummary>();
  const circuit = getGlobalHealCircuit();

  for await (const line of streamShards(metricsDir(), { since: sinceMs })) {
    const obj = line as Record<string, unknown>;
    if (obj['type'] !== 'error' && obj['type'] !== 'turn_complete') continue;
    const code = typeof obj['code'] === 'string' ? (obj['code'] as string) : null;
    if (!code) continue;
    if (filterCode && !code.startsWith(filterCode.replace('*', ''))) continue;

    const ts = typeof obj['ts'] === 'number' ? (obj['ts'] as number) : 0;
    const existing = counts.get(code) ?? {
      code,
      count: 0,
      lastOccurrence: 0,
      circuitOpen: circuit.isOpen(code),
    };
    existing.count += 1;
    if (ts > existing.lastOccurrence) existing.lastOccurrence = ts;
    counts.set(code, existing);
  }

  const summaries = [...counts.values()].sort((a, b) => b.count - a.count);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(summaries) + '\n');
    return summaries.length > 0 ? 1 : 0;
  }

  if (summaries.length === 0) {
    process.stdout.write('nimbus errors: no errors found in range\n');
    return 0;
  }

  process.stdout.write(`nimbus errors (since ${new Date(sinceMs).toISOString()})\n`);
  process.stdout.write(`${'code'.padEnd(28)} ${'count'.padStart(6)}  ${'last'.padEnd(24)} ${'circuit'.padStart(8)}\n`);
  process.stdout.write(`${'-'.repeat(72)}\n`);

  for (const s of summaries) {
    const last = s.lastOccurrence > 0 ? new Date(s.lastOccurrence).toISOString() : 'never';
    const circ = s.circuitOpen ? 'OPEN' : 'closed';
    process.stdout.write(
      `${s.code.padEnd(28)} ${String(s.count).padStart(6)}  ${last.padEnd(24)} ${circ.padStart(8)}\n`,
    );
  }
  return 1;
}
