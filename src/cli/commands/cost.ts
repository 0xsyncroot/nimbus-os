// cost.ts — SPEC-701: `nimbus cost [--today|--week|--month] [--by session|provider|day] [--json]`.
// Routes to cost/dashboard.ts which aggregates ledger events for the active workspace.

import { getActiveWorkspace } from '../../core/workspace.ts';
import { aggregate } from '../../cost/aggregator.ts';
import { renderRollup, type GroupBy } from '../../cost/dashboard.ts';
import type { AggregateWindow } from '../../cost/types.ts';

function parseWindow(args: string[]): AggregateWindow {
  if (args.includes('--today')) return 'today';
  if (args.includes('--week')) return 'week';
  if (args.includes('--month')) return 'month';
  return 'today';
}

function parseBy(args: string[]): GroupBy {
  const idx = args.indexOf('--by');
  if (idx >= 0 && args[idx + 1]) {
    const v = args[idx + 1]!;
    if (v === 'session' || v === 'provider' || v === 'day') return v;
  }
  return 'provider';
}

export async function runCost(args: string[]): Promise<number> {
  const active = await getActiveWorkspace();
  if (!active) {
    process.stderr.write('no active workspace — run `nimbus init` first\n');
    return 2;
  }

  const window = parseWindow(args);
  const by = parseBy(args);
  const jsonMode = args.includes('--json');

  const rollup = await aggregate(active.id, window);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ window, by, rollup }) + '\n');
    return 0;
  }

  process.stdout.write(renderRollup(rollup, { window, by }) + '\n');
  return 0;
}
