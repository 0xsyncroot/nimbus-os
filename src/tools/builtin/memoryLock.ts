// memoryLock.ts — SPEC-304 T1: sidecar-file lock for MEMORY.md append.

import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';

export interface MemoryLockHandle {
  release(): Promise<void>;
  readonly acquiredAt: number;
  readonly nonce: string;
}

interface SidecarContent {
  pid: number;
  nonce: string;
  acquiredAt: number;
}

const STALE_AGE_MS = 30_000;

function randNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tryWriteLock(lockPath: string, content: SidecarContent): Promise<boolean> {
  try {
    const fh = await open(lockPath, 'wx');
    await fh.writeFile(JSON.stringify(content), { encoding: 'utf8' });
    await fh.close();
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw err;
  }
}

async function readSidecar(lockPath: string): Promise<SidecarContent | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as SidecarContent;
    if (typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string' || typeof parsed.acquiredAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    const age = Date.now() - st.mtimeMs;
    if (age > STALE_AGE_MS) return true;
  } catch {
    return false;
  }
  const side = await readSidecar(lockPath);
  if (!side) return false;
  if (side.pid !== process.pid && !pidAlive(side.pid)) return true;
  return false;
}

export async function acquireMemoryLock(
  lockPath: string,
  timeoutMs: number,
): Promise<MemoryLockHandle> {
  const deadline = Date.now() + timeoutMs;
  const nonce = randNonce();
  while (true) {
    const acquiredAt = Date.now();
    const ok = await tryWriteLock(lockPath, { pid: process.pid, nonce, acquiredAt });
    if (ok) {
      return {
        acquiredAt,
        nonce,
        async release(): Promise<void> {
          const current = await readSidecar(lockPath);
          if (current && current.nonce !== nonce) {
            // Someone else owns it now — refuse to steal.
            return;
          }
          await unlink(lockPath).catch(() => undefined);
        },
      };
    }
    if (await isStale(lockPath)) {
      await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new NimbusError(ErrorCode.S_MEMORY_CONFLICT, {
        reason: 'lock_timeout',
        lockPath,
        timeoutMs,
      });
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Exported for tests only.
export const __test = { randNonce, isStale, readSidecar, writeFile };
