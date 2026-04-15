// dashboard.ts — SPEC-701 T6: CLI render for `nimbus cost [--today|week|month]`.

import { aggregate } from './aggregator.ts';
import type { AggregateWindow, CostRollup } from './types.ts';

export type GroupBy = 'session' | 'provider' | 'day';

export interface RenderOptions {
  window: AggregateWindow;
  by?: GroupBy;
  /** Redact session IDs to first 8 chars (default true). */
  redactSessions?: boolean;
}

function fmtUsd(n: number): string {
  if (n >= 10) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function redactSession(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function windowLabel(w: AggregateWindow): string {
  if (w === 'today') return 'Today';
  if (w === 'week') return 'Last 7 days';
  return 'Last 30 days';
}

export function renderRollup(rollup: CostRollup, opts: RenderOptions): string {
  const lines: string[] = [];
  lines.push(`Cost — ${windowLabel(opts.window)}`);
  lines.push(`Total: ${fmtUsd(rollup.totalUsd)}  (${rollup.events} events)`);
  lines.push('');
  const by = opts.by ?? 'provider';
  lines.push(`By ${by}:`);
  const bucket: Record<string, number> =
    by === 'session'
      ? rollup.bySession
      : by === 'day'
      ? rollup.byDay
      : rollup.byProvider;
  const redact = by === 'session' && opts.redactSessions !== false;
  const rows = Object.entries(bucket).sort(([, a], [, b]) => b - a);
  if (rows.length === 0) {
    lines.push('  (no events)');
  } else {
    for (const [k, v] of rows) {
      const label = redact ? redactSession(k) : k;
      lines.push(`  ${label.padEnd(24)} ${fmtUsd(v)}`);
    }
  }
  return lines.join('\n');
}

export async function showCost(
  workspaceId: string,
  opts: RenderOptions,
): Promise<string> {
  const rollup = await aggregate(workspaceId, opts.window);
  return renderRollup(rollup, opts);
}
