// trace.ts — SPEC-603: `nimbus debug trace <turnId>` — tree: turn → tool_calls → retries → errors.
// Moved from src/cli/commands/trace.ts (SPEC-828).

import { streamShards, metricsDir } from '../../observability/reader.ts';

export async function runTrace(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const nonFlags = args.filter((a) => !a.startsWith('-'));
  const turnId = nonFlags[0] ?? null;

  if (!turnId) {
    process.stderr.write('Usage: nimbus debug trace <turnId>\n');
    return 1;
  }

  const events: Array<Record<string, unknown>> = [];

  // Scan last 7 days for the turn
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for await (const line of streamShards(metricsDir(), { since: sinceMs })) {
    const obj = line as Record<string, unknown>;
    if (obj['turnId'] === turnId) {
      events.push(obj);
    }
  }

  if (events.length === 0) {
    process.stderr.write(`nimbus trace: no events found for turnId=${turnId}\n`);
    return 1;
  }

  // Sort by ts
  events.sort((a, b) => ((a['ts'] as number) ?? 0) - ((b['ts'] as number) ?? 0));

  if (jsonMode) {
    process.stdout.write(JSON.stringify(events) + '\n');
    return 0;
  }

  process.stdout.write(`nimbus trace ${turnId}\n`);
  process.stdout.write(`${'-'.repeat(60)}\n`);
  for (const ev of events) {
    const ts = ev['ts'] ? new Date(ev['ts'] as number).toISOString() : '?';
    const type = typeof ev['type'] === 'string' ? ev['type'] : 'unknown';
    const extras: string[] = [];
    if (ev['name']) extras.push(`tool=${String(ev['name'])}`);
    if (ev['ok'] !== undefined) extras.push(`ok=${String(ev['ok'])}`);
    if (ev['ms']) extras.push(`ms=${String(ev['ms'])}`);
    if (ev['code']) extras.push(`code=${String(ev['code'])}`);
    process.stdout.write(`  ${ts}  ${type.padEnd(20)}  ${extras.join('  ')}\n`);
  }
  return 0;
}
