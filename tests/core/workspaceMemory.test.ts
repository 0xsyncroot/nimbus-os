import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { invalidate, loadWorkspaceMemory, peekCache } from '../../src/core/workspaceMemory.ts';
import { workspacesDir } from '../../src/platform/paths.ts';

const OVERRIDE = join(tmpdir(), `nimbus-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});

describe('SPEC-104: workspaceMemory', () => {
  test('loads scaffolded files', async () => {
    const { meta } = await createWorkspaceDir({ name: 'mem-test' });
    const mem = await loadWorkspaceMemory(meta.id);
    expect(mem.soulMd.body.length).toBeGreaterThan(0);
    expect(mem.toolsMd.body.length).toBeGreaterThan(0);
    expect(mem.memoryMd.body.length).toBeGreaterThan(0);
  });

  test('cache hit + invalidate', async () => {
    const { meta } = await createWorkspaceDir({ name: 'cache-test' });
    await loadWorkspaceMemory(meta.id);
    expect(peekCache(meta.id)).not.toBeNull();
    invalidate(meta.id);
    expect(peekCache(meta.id)).toBeNull();
  });

  test('missing SOUL.md throws S_SOUL_PARSE', async () => {
    const { meta } = await createWorkspaceDir({ name: 'nosoul' });
    await rm(join(workspacesDir(), meta.id, 'SOUL.md'));
    invalidate(meta.id);
    try {
      await loadWorkspaceMemory(meta.id);
      throw new Error('should throw');
    } catch (err) {
      expect((err as Error).message).toContain('S_SOUL_PARSE');
    }
  });
});
