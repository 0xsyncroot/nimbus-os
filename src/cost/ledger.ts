// ledger.ts — SPEC-701 T4: month-sharded JSONL writer + _index.json refresh.

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspacesDir } from '../platform/paths.ts';
import { ErrorCode, NimbusError, wrapError } from '../observability/errors.ts';
import { CostEventSchema, type CostEvent } from './types.ts';

const MAX_LINE_BYTES = 256 * 1024;

export interface LedgerIndex {
  schemaVersion: 1;
  lastUpdated: number;
  months: Record<string, { events: number; totalUsd: number }>;
}

function costsDir(workspaceId: string): string {
  return join(workspacesDir(), workspaceId, 'costs');
}

export function monthKey(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function monthPath(workspaceId: string, month: string): string {
  return join(costsDir(workspaceId), `${month}.jsonl`);
}

function indexPath(workspaceId: string): string {
  return join(costsDir(workspaceId), '_index.json');
}

export async function appendCostEvent(event: CostEvent): Promise<void> {
  const parsed = CostEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'invalid_cost_event',
      issues: parsed.error.issues.map((i) => ({
        pointer: '/' + i.path.map(String).join('/'),
        message: i.message,
      })),
    });
  }
  const ev = parsed.data;
  const dir = costsDir(ev.workspaceId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify(ev);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LINE_BYTES) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'cost_line_too_large',
      size: bytes,
    });
  }
  const path = monthPath(ev.workspaceId, monthKey(ev.ts));
  try {
    await appendFile(path, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw wrapError(err, ErrorCode.S_STORAGE_CORRUPT, {
      reason: 'cost_append_failed',
      path,
    });
  }
  await bumpIndex(ev.workspaceId, monthKey(ev.ts), ev.costUsd);
}

async function bumpIndex(
  workspaceId: string,
  month: string,
  costUsd: number,
): Promise<void> {
  const path = indexPath(workspaceId);
  let idx: LedgerIndex;
  try {
    const raw = await readFile(path, 'utf8');
    const json = JSON.parse(raw) as LedgerIndex;
    if (json && typeof json === 'object' && json.schemaVersion === 1) {
      idx = json;
    } else {
      idx = emptyIndex();
    }
  } catch {
    idx = emptyIndex();
  }
  const entry = idx.months[month] ?? { events: 0, totalUsd: 0 };
  entry.events += 1;
  entry.totalUsd = round6(entry.totalUsd + costUsd);
  idx.months[month] = entry;
  idx.lastUpdated = Date.now();
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(idx, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tmp, path);
}

function emptyIndex(): LedgerIndex {
  return { schemaVersion: 1, lastUpdated: Date.now(), months: {} };
}

export async function readMonth(
  workspaceId: string,
  month: string,
): Promise<CostEvent[]> {
  const path = monthPath(workspaceId, month);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const events: CostEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = CostEventSchema.parse(JSON.parse(line));
      events.push(parsed);
    } catch {
      // Skip malformed lines; ledger is append-only but we are defensive.
    }
  }
  return events;
}

export async function listMonths(workspaceId: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(costsDir(workspaceId));
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^\d{4}-\d{2}\.jsonl$/.test(e))
    .map((e) => e.slice(0, 7))
    .sort();
}

export async function readIndex(
  workspaceId: string,
): Promise<LedgerIndex | null> {
  try {
    const raw = await readFile(indexPath(workspaceId), 'utf8');
    const json = JSON.parse(raw) as LedgerIndex;
    if (json && typeof json === 'object' && json.schemaVersion === 1) return json;
    return null;
  } catch {
    return null;
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
