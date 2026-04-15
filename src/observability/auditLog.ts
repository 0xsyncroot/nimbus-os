// auditLog.ts — SPEC-119: JSONL append audit log with SHA-256 digest + per-day rollover.

import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NimbusError } from './errors.ts';
import { logger } from './logger.ts';
import { logsDir } from '../platform/paths.ts';
import { detect } from '../platform/detect.ts';
import {
  AUDIT_LINE_MAX_BYTES,
  AuditEntrySchema,
  type AuditEntry,
} from './auditTypes.ts';

function dayKey(ts: number, clock?: { now(): number }): string {
  const date = new Date(ts ?? (clock?.now ? clock.now() : Date.now()));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function auditDir(): string {
  return join(logsDir(), 'audit');
}

export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}

function sortedStringify(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + sortedStringify(obj[k])).join(',') + '}';
}

export function digestInput(input: unknown): string {
  const canonical = sortedStringify(input);
  return sha256Hex(canonical);
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const parsed = AuditEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'invalid_audit_entry',
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  const line = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > AUDIT_LINE_MAX_BYTES) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'audit_line_too_large', size: bytes });
  }
  const dir = auditDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${dayKey(parsed.data.ts)}.jsonl`);
  try {
    await appendFile(filePath, line + '\n', { encoding: 'utf8' });
    if (detect().os !== 'win32') {
      await chmod(filePath, 0o600).catch(() => undefined);
    }
  } catch (err) {
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, {
      reason: 'audit_append_failed',
      err: (err as Error).message,
    });
  }
}

export async function computeAndAppend(params: {
  sessionId: string;
  kind: AuditEntry['kind'];
  toolName: string;
  toolInput: unknown;
  outcome: AuditEntry['outcome'];
  decisionReason?: string;
}): Promise<void> {
  const entry: AuditEntry = {
    schemaVersion: 1,
    ts: Date.now(),
    sessionId: params.sessionId,
    kind: params.kind,
    toolName: params.toolName,
    inputDigest: digestInput(params.toolInput),
    outcome: params.outcome,
  };
  if (params.decisionReason !== undefined) entry.decisionReason = params.decisionReason;
  try {
    await appendAudit(entry);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'audit append failed');
    throw err;
  }
}

export { AUDIT_LINE_MAX_BYTES };
