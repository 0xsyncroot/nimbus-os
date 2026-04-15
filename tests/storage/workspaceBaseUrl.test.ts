import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceDir, loadWorkspace } from '../../src/storage/workspaceStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import { WorkspaceSchema } from '../../src/core/workspaceTypes.ts';

const OVERRIDE = join(tmpdir(), `nimbus-ws-baseurl-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

describe('Task #31: workspace schema baseUrl/endpoint roundtrip', () => {
  test('create + load preserves defaultEndpoint + defaultBaseUrl', async () => {
    const { meta } = await createWorkspaceDir({
      name: 'vllm-test',
      defaultProvider: 'openai-compat',
      defaultModel: 'llama-3',
      defaultEndpoint: 'custom',
      defaultBaseUrl: 'http://localhost:9000/v1',
    });
    expect(meta.defaultEndpoint).toBe('custom');
    expect(meta.defaultBaseUrl).toBe('http://localhost:9000/v1');
    const { meta: reloaded } = await loadWorkspace(meta.id);
    expect(reloaded.defaultEndpoint).toBe('custom');
    expect(reloaded.defaultBaseUrl).toBe('http://localhost:9000/v1');
  });

  test('create without endpoint is backwards-compatible', async () => {
    const { meta } = await createWorkspaceDir({ name: 'legacy-ws' });
    expect(meta.defaultEndpoint).toBeUndefined();
    expect(meta.defaultBaseUrl).toBeUndefined();
  });

  test('schema rejects endpoint=custom without baseUrl', () => {
    expect(() =>
      WorkspaceSchema.parse({
        schemaVersion: 1,
        id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'x',
        createdAt: 1,
        lastUsed: 1,
        defaultProvider: 'openai-compat',
        defaultModel: 'm',
        defaultEndpoint: 'custom',
      }),
    ).toThrow();
  });

  test('schema rejects invalid baseUrl', () => {
    expect(() =>
      WorkspaceSchema.parse({
        schemaVersion: 1,
        id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'x',
        createdAt: 1,
        lastUsed: 1,
        defaultProvider: 'openai-compat',
        defaultModel: 'm',
        defaultEndpoint: 'custom',
        defaultBaseUrl: 'not-a-url',
      }),
    ).toThrow();
  });
});
