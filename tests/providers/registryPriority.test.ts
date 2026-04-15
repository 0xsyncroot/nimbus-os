// tests/providers/registryPriority.test.ts — SPEC-902 §3 priority chain.
//
// Explicit coverage for the baseUrl + apiKey priority chain implemented in
// resolveProviderKey(). Ordered weakest → strongest:
//   secrets   — vault has key + meta.baseUrl
//   env       — OPENAI_API_KEY / ANTHROPIC_API_KEY
//   config    — workspace.json defaultBaseUrl
//   cli       — --api-key / --base-url flags

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviderKey } from '../../src/providers/registry.ts';
import { createKeyManager } from '../../src/key/manager.ts';
import { __resetSecretStoreCache, getBest } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { switchWorkspace } from '../../src/core/workspace.ts';

const VAULT_KEY = 'vault-key-' + 'A'.repeat(30);
const VAULT_BASE = 'http://localhost:9000/v1';

let tmpRoot: string;
let wsId: string;

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'priority-chain-test';
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
});

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-priority-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  delete process.env['OPENAI_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetDetectCache();
  const { meta } = await createWorkspaceDir({ name: 'prio' });
  wsId = meta.id;
  await switchWorkspace(wsId);
  const km = createKeyManager({ secretStore: await getBest() });
  await km.set('openai', VAULT_KEY, { baseUrl: VAULT_BASE });
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['OPENAI_API_KEY'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});

describe('SPEC-902: resolveProviderKey priority chain', () => {
  test('bottom: secrets (vault key + vault baseUrl)', async () => {
    const resolved = await resolveProviderKey({ providerId: 'openai', wsId });
    expect(resolved.source).toBe('secrets');
    expect(resolved.apiKey).toBe(VAULT_KEY);
    expect(resolved.baseUrl).toBe(VAULT_BASE);
  });

  test('env OPENAI_API_KEY overrides vault key (baseUrl still from vault)', async () => {
    process.env['OPENAI_API_KEY'] = 'env-key-override';
    const resolved = await resolveProviderKey({ providerId: 'openai', wsId });
    expect(resolved.source).toBe('env');
    expect(resolved.apiKey).toBe('env-key-override');
    expect(resolved.baseUrl).toBe(VAULT_BASE);
  });

  test('configBaseUrl (workspace.json) overrides vault baseUrl', async () => {
    const resolved = await resolveProviderKey({
      providerId: 'openai',
      wsId,
      configBaseUrl: 'https://workspace-override/v1',
    });
    expect(resolved.source).toBe('secrets');
    expect(resolved.baseUrl).toBe('https://workspace-override/v1');
  });

  test('cliKey + cliBaseUrl win over everything (explicit one-off)', async () => {
    process.env['OPENAI_API_KEY'] = 'env-loser';
    const resolved = await resolveProviderKey({
      providerId: 'openai',
      wsId,
      cliKey: 'cli-winner',
      cliBaseUrl: 'https://cli-override/v1',
      configBaseUrl: 'https://workspace-loser/v1',
    });
    expect(resolved.source).toBe('cli');
    expect(resolved.apiKey).toBe('cli-winner');
    expect(resolved.baseUrl).toBe('https://cli-override/v1');
  });

  test('no key anywhere → U_MISSING_CONFIG with actionable hint', async () => {
    const { meta: emptyMeta } = await createWorkspaceDir({ name: 'emptyprio' });
    let err: unknown = null;
    try {
      await resolveProviderKey({ providerId: 'groq', wsId: emptyMeta.id });
    } catch (e) {
      err = e;
    }
    expect((err as { code: string }).code).toBe('U_MISSING_CONFIG');
    expect(String((err as { context: { hint: string } }).context.hint)).toContain('nimbus key set');
  });

  test('vault baseUrl only; vault entry missing for different provider', async () => {
    const resolved = await resolveProviderKey({ providerId: 'openai', wsId });
    // still opens openai entry → baseUrl present
    expect(resolved.baseUrl).toBe(VAULT_BASE);
    // but groq in same workspace has nothing
    let err: unknown = null;
    try {
      await resolveProviderKey({ providerId: 'groq', wsId });
    } catch (e) {
      err = e;
    }
    expect((err as { code: string }).code).toBe('U_MISSING_CONFIG');
  });
});
