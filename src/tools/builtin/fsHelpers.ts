// fsHelpers.ts — SPEC-302 T1: shared filesystem helpers with pathValidator integration.

import { lstat, stat } from 'node:fs/promises';
import { isAbsolute, resolve, basename } from 'node:path';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { validatePath } from '../../permissions/pathValidator.ts';

export const MAX_READ_BYTES = 10 * 1024 * 1024;
export const MAX_WRITE_BYTES = 50 * 1024 * 1024;
export const MAX_GREP_BYTES = 5 * 1024 * 1024;

const WORKSPACE_SENSITIVE = new Set(['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md']);

export function resolveWorkspacePath(cwd: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'empty_path' });
  }
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  validatePath(abs, cwd);
  return abs;
}

export async function assertSize(path: string, max: number): Promise<number> {
  const st = await stat(path);
  if (st.size > max) {
    throw new NimbusError(ErrorCode.T_VALIDATION, {
      reason: 'file_too_large',
      size: st.size,
      max,
      path,
    });
  }
  return st.size;
}

export async function assertNotSymlink(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'symlink', path });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.T_CRASH, { reason: 'lstat_failed', path }, err as Error);
  }
}

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readTextWithLineNumbers(
  text: string,
  offset = 0,
  limit?: number,
): { content: string; totalLines: number; returnedLines: number } {
  const lines = text.split('\n');
  const totalLines = lines.length;
  const start = Math.max(0, offset);
  const end = limit !== undefined ? Math.min(totalLines, start + limit) : totalLines;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const lineNo = i + 1;
    const pad = String(lineNo).padStart(6, ' ');
    out.push(`${pad}\t${lines[i] ?? ''}`);
  }
  return { content: out.join('\n'), totalLines, returnedLines: end - start };
}

/** Returns file mode: 0o600 for workspace-root sensitive markdown files, 0o644 otherwise. */
export function chooseMode(path: string): number {
  const base = basename(path);
  if (WORKSPACE_SENSITIVE.has(base)) return 0o600;
  return 0o644;
}

export function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

// Secret pattern redaction shared by Grep + Bash output.
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-api03-[A-Za-z0-9_\-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_\-]{35}/g,
  /xox[baprs]-[0-9A-Za-z-]{10,}/g,
];

export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '***redacted***');
  }
  return out;
}
