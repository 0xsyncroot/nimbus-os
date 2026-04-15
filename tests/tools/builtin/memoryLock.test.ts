// tests/tools/builtin/memoryLock.test.ts — SPEC-304 T1.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMemoryLock } from '../../../src/tools/builtin/memoryLock.ts';
import { ErrorCode, NimbusError } from '../../../src/observability/errors.ts';

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'memlock-')); });
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

describe('SPEC-304: memoryLock', () => {
  test('acquire + release + re-acquire', async () => {
    const p = join(root, 'a.lock');
    const l1 = await acquireMemoryLock(p, 500);
    await l1.release();
    const l2 = await acquireMemoryLock(p, 500);
    await l2.release();
  });

  test('stale lock (dead PID) reclaimed', async () => {
    const p = join(root, 'b.lock');
    writeFileSync(p, JSON.stringify({ pid: 999999, nonce: 'dead', acquiredAt: Date.now() - 1000 }));
    const l = await acquireMemoryLock(p, 1000);
    await l.release();
  });

  test('timeout when held', async () => {
    const p = join(root, 'c.lock');
    const l1 = await acquireMemoryLock(p, 500);
    try {
      await acquireMemoryLock(p, 100);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_MEMORY_CONFLICT);
    } finally {
      await l1.release();
    }
  });
});
