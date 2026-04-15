// Memory.ts — SPEC-304 T2: append-only MEMORY.md writer with lock + reconcile.

import { mkdir, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { sha256Hex } from '../../observability/auditLog.ts';
import { workspacePaths } from '../../core/workspaceMemory.ts';
import { acquireMemoryLock } from './memoryLock.ts';
import type { Tool } from '../types.ts';

export const MemoryInputSchema = z.object({
  entry: z.string().min(1).max(4096),
  section: z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/).optional(),
  tags: z.array(z.string().max(32)).max(8).optional(),
}).strict();
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

export interface MemoryOutput {
  section: string;
  appendedBytes: number;
  reconciled: boolean;
}

const SECRET_RES: RegExp[] = [
  /sk-ant-api03-[A-Za-z0-9_\-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];

function containsSecret(s: string): boolean {
  return SECRET_RES.some((re) => re.test(s));
}

function formatEntry(input: MemoryInput, ts: Date): string {
  const stamp = ts.toISOString();
  const tagLine = input.tags && input.tags.length > 0 ? ` [${input.tags.join(', ')}]` : '';
  return `- ${stamp}${tagLine} ${input.entry.trim()}`;
}

function appendToSection(existing: string, input: MemoryInput, ts: Date): { out: string; section: string } {
  const section = input.section ?? 'Notes';
  const header = `## ${section}`;
  const entry = formatEntry(input, ts);
  const lines = existing.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx === -1) {
    const trimmed = existing.replace(/\n+$/, '');
    const out = `${trimmed}${trimmed ? '\n\n' : ''}${header}\n\n${entry}\n`;
    return { out, section };
  }
  // Insert at end of that section (before next ## or eof).
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? '')) { endIdx = i; break; }
  }
  const before = lines.slice(0, endIdx);
  const after = lines.slice(endIdx);
  // Strip trailing blanks from before.
  while (before.length > 0 && (before[before.length - 1] ?? '').trim() === '') before.pop();
  before.push(entry);
  const out = [...before, '', ...after].join('\n');
  return { out, section };
}

function appendReconcile(existing: string, input: MemoryInput, ts: Date): { out: string; section: string } {
  const section = `Conflict ${ts.toISOString()}`;
  const header = `## ${section}`;
  const entry = formatEntry(input, ts);
  const trimmed = existing.replace(/\n+$/, '');
  const out = `${trimmed}\n\n${header}\n\n${entry}\n`;
  return { out, section };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = path + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export function createMemoryTool(): Tool<MemoryInput, MemoryOutput> {
  return {
    name: 'Memory',
    description: 'Append a note to the workspace MEMORY.md file. Cannot delete or overwrite. Sole writer to MEMORY.md.',
    readOnly: false,
    inputSchema: MemoryInputSchema,
    async handler(input, ctx) {
      try {
        if (containsSecret(input.entry)) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.X_CRED_ACCESS, {
              reason: 'secret_in_entry',
              hint: 'do not persist secrets to MEMORY.md',
            }),
          };
        }
        const paths = workspacePaths(ctx.workspaceId);
        await mkdir(dirname(paths.memoryMd), { recursive: true });

        const lockPath = paths.memoryMd + '.lock';
        const lock = await acquireMemoryLock(lockPath, 5000);
        let reconciled = false;
        let section = '';
        let appendedBytes = 0;
        try {
          let stat0: { mtimeMs: number; size: number } | null = null;
          try { stat0 = await stat(paths.memoryMd); } catch { stat0 = null; }
          const existed = stat0 !== null;
          let existing = '';
          if (existed) {
            existing = await Bun.file(paths.memoryMd).text();
          }
          // Re-stat to detect external modification (only meaningful if already present).
          let conflict = false;
          if (stat0) {
            try {
              const stat1 = await stat(paths.memoryMd);
              if (stat1.mtimeMs !== stat0.mtimeMs || stat1.size !== stat0.size) conflict = true;
            } catch {
              // disappeared — treat as new file
              existing = '';
            }
          }
          const ts = new Date();
          const result = conflict
            ? appendReconcile(existing, input, ts)
            : appendToSection(existing, input, ts);
          section = result.section;
          reconciled = conflict;
          await atomicWrite(paths.memoryMd, result.out);
          appendedBytes = Buffer.byteLength(result.out, 'utf8') - Buffer.byteLength(existing, 'utf8');
          logger.debug({
            sessionId: ctx.sessionId,
            section,
            reconciled,
            entryDigest: sha256Hex(input.entry),
          }, 'memory.append');
        } finally {
          await lock.release();
        }
        return {
          ok: true,
          output: { section, appendedBytes, reconciled },
          display: reconciled
            ? `memory appended under Conflict section (external modification detected)`
            : `memory appended under "${section}"`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
