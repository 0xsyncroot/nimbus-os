// audit.ts — SPEC-603: `nimbus audit [--since] [--severity]` — SecurityEvent + exec/write calls.
// Reads from both metrics dir (error events) and audit dir (tool_call / permission_decision).

import { join } from 'node:path';
import { streamShards, metricsDir, parseSince } from '../../observability/reader.ts';
import { logsDir } from '../../platform/paths.ts';

function auditDir(): string {
  return join(logsDir(), 'audit');
}

export async function runAudit(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const sinceIdx = args.indexOf('--since');
  const sinceStr = sinceIdx >= 0 ? args[sinceIdx + 1] : '1d';
  const sinceMs = parseSince(sinceStr ?? '1d');

  const severityIdx = args.indexOf('--severity');
  const filterSeverity = severityIdx >= 0 ? (args[severityIdx + 1] ?? null) : null;

  const entries: Array<Record<string, unknown>> = [];

  // Read from audit JSONL (tool_call / permission_decision)
  for await (const line of streamShards(auditDir(), { since: sinceMs })) {
    const obj = line as Record<string, unknown>;
    entries.push(obj);
  }

  // Read X_* security events from metrics
  for await (const line of streamShards(metricsDir(), { since: sinceMs })) {
    const obj = line as Record<string, unknown>;
    const code = typeof obj['code'] === 'string' ? obj['code'] : '';
    if ((code as string).startsWith('X_') || obj['event'] === 'security_event') {
      entries.push({ ...obj, severity: 'high', auditKind: 'security_event' });
    }
  }

  // Apply severity filter
  const filtered = filterSeverity
    ? entries.filter((e) => {
        const sev = typeof e['severity'] === 'string' ? e['severity'] : 'normal';
        return sev === filterSeverity;
      })
    : entries;

  // Sort by ts
  filtered.sort((a, b) => ((a['ts'] as number) ?? 0) - ((b['ts'] as number) ?? 0));

  if (jsonMode) {
    // --json must have no ANSI codes (spec requirement)
    process.stdout.write(JSON.stringify(filtered) + '\n');
    return filtered.length > 0 ? 1 : 0;
  }

  if (filtered.length === 0) {
    process.stdout.write('nimbus audit: no audit events found in range\n');
    return 0;
  }

  process.stdout.write(`nimbus audit (since ${new Date(sinceMs).toISOString()})\n`);
  process.stdout.write(`${'-'.repeat(80)}\n`);
  for (const e of filtered) {
    const ts = e['ts'] ? new Date(e['ts'] as number).toISOString() : '?';
    const kind = e['auditKind'] ?? e['kind'] ?? e['type'] ?? 'event';
    const tool = e['toolName'] ?? e['name'] ?? '';
    const outcome = e['outcome'] ?? e['code'] ?? '';
    const severity = e['severity'] ?? '';
    process.stdout.write(
      `  ${ts}  ${String(kind).padEnd(20)}  ${String(tool).padEnd(16)}  ${String(outcome).padEnd(10)}  ${String(severity)}\n`,
    );
  }
  return filtered.length > 0 ? 1 : 0;
}
