import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkspaceDir,
  listWorkspaces,
  loadWorkspace,
  updateWorkspace,
} from '../../src/storage/workspaceStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

const OVERRIDE = join(tmpdir(), `nimbus-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(workspacesDir(), { recursive: true, force: true });
});

describe('SPEC-101: workspaceStore', () => {
  test('create + load round-trip', async () => {
    const { meta } = await createWorkspaceDir({ name: 'alpha' });
    const { meta: loaded } = await loadWorkspace(meta.id);
    expect(loaded.name).toBe('alpha');
    expect(loaded.id).toBe(meta.id);
  });

  test('duplicate name rejected', async () => {
    await createWorkspaceDir({ name: 'beta' });
    try {
      await createWorkspaceDir({ name: 'beta' });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });

  test('invalid name rejected', async () => {
    try {
      await createWorkspaceDir({ name: '../bad' });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
    }
  });

  test('atomic rollback on injected failure', async () => {
    try {
      await createWorkspaceDir({
        name: 'gamma',
        injectFailAfterDir: async () => {
          throw new Error('boom');
        },
      });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
    }
    const list = await listWorkspaces();
    expect(list.find((w) => w.name === 'gamma')).toBeUndefined();
  });

  test('list sorted by lastUsed desc', async () => {
    const a = await createWorkspaceDir({ name: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createWorkspaceDir({ name: 'b' });
    const list = await listWorkspaces();
    expect(list.map((w) => w.id)).toEqual([b.meta.id, a.meta.id]);
  });

  test('updateWorkspace writes changes', async () => {
    const { meta } = await createWorkspaceDir({ name: 'delta' });
    const newTs = Date.now() + 10000;
    const upd = await updateWorkspace(meta.id, { lastUsed: newTs });
    expect(upd.lastUsed).toBe(newTs);
    const { meta: reload } = await loadWorkspace(meta.id);
    expect(reload.lastUsed).toBe(newTs);
  });
});
