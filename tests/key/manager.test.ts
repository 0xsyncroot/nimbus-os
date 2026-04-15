// tests/key/manager.test.ts (SPEC-902 §6.1)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeyManager,
  keyringServiceName,
  maskKey,
  type KeyManager,
} from '../../src/key/manager.ts';
import { __resetSecretStoreCache, getBest } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { switchWorkspace } from '../../src/core/workspace.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

const ANTH_KEY = 'sk-ant-' + 'A'.repeat(40);
const OAI_KEY = 'sk-' + 'B'.repeat(40);

let tmpRoot: string;
let wsId: string;
let manager: KeyManager;

beforeAll(() => {
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass-phrase-for-key-manager';
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
});
afterAll(() => {
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
});

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-key-mgr-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetDetectCache();
  const { meta } = await createWorkspaceDir({ name: 'testws' });
  wsId = meta.id;
  await switchWorkspace(wsId);
  manager = createKeyManager({
    secretStore: await getBest(),
    testKey: async () => ({ ok: true, latencyMs: 1, costUsd: 0 }),
  });
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});

describe('SPEC-902: KeyManager', () => {
  test('set → list → delete → list round-trip', async () => {
    await manager.set('anthropic', ANTH_KEY);
    let entries = await manager.list();
    expect(entries.length).toBe(1);
    expect(entries[0]?.provider).toBe('anthropic');
    await manager.delete('anthropic');
    entries = await manager.list();
    expect(entries.length).toBe(0);
  });

  test('list redacts to prefix + last4', async () => {
    await manager.set('anthropic', ANTH_KEY);
    const entries = await manager.list();
    const masked = entries[0]?.masked ?? '';
    // Must not contain the long middle of the raw key
    expect(masked).not.toContain('A'.repeat(20));
    expect(masked).toContain('sk-ant');
    // Must reveal at most 4 trailing chars
    const trailing = masked.replace(/.*\*+/, '');
    expect(trailing.length).toBeLessThanOrEqual(4);
  });

  test('set rejects malformed key BEFORE storing (no keyring write)', async () => {
    let err: unknown = null;
    try {
      await manager.set('anthropic', 'not-a-key');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    const entries = await manager.list();
    expect(entries.length).toBe(0);
  });

  test('delete missing key throws U_MISSING_CONFIG', async () => {
    let err: unknown = null;
    try {
      await manager.delete('openai');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_MISSING_CONFIG);
  });

  test('test() returns ok via injected testKey', async () => {
    await manager.set('anthropic', ANTH_KEY);
    const result = await manager.test('anthropic');
    expect(result.ok).toBe(true);
  });

  test('test() distinguishes auth failure', async () => {
    const failingMgr = createKeyManager({
      secretStore: await getBest(),
      testKey: async () => ({
        ok: false,
        latencyMs: 100,
        costUsd: 0,
        errorCode: ErrorCode.P_AUTH,
      }),
    });
    await failingMgr.set('anthropic', ANTH_KEY);
    const result = await failingMgr.test('anthropic');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(ErrorCode.P_AUTH);
  });

  test('liveTest=true rejects on failure WITHOUT storing', async () => {
    const failingMgr = createKeyManager({
      secretStore: await getBest(),
      testKey: async () => ({
        ok: false,
        latencyMs: 50,
        costUsd: 0,
        errorCode: ErrorCode.P_AUTH,
      }),
    });
    let err: unknown = null;
    try {
      await failingMgr.set('openai', OAI_KEY, { liveTest: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.P_AUTH);
    const entries = await failingMgr.list();
    expect(entries.length).toBe(0);
  });

  test('per-workspace namespace isolates keys', async () => {
    await manager.set('anthropic', ANTH_KEY);
    const { meta: meta2 } = await createWorkspaceDir({ name: 'second' });
    const list2 = await manager.list(meta2.id);
    expect(list2.length).toBe(0);
    const list1 = await manager.list(wsId);
    expect(list1.length).toBe(1);
  });

  test('keyringServiceName uses nimbus-os.{wsId} format', () => {
    expect(keyringServiceName('01H123ABC')).toBe('nimbus-os.01H123ABC');
  });

  test('maskKey never reveals more than 4 trailing chars', () => {
    const masked = maskKey('sk-ant-' + 'X'.repeat(40));
    const trailing = masked.replace(/.*\*+/, '');
    expect(trailing.length).toBeLessThanOrEqual(4);
  });

  // Bugfix #5 — baseUrl sidecar readable so REPL boot path can pick it up.
  test('getBaseUrl returns baseUrl that was stored via set()', async () => {
    await manager.set('openai', 'local-vllm-any', {
      baseUrl: 'http://localhost:9000/v1',
    });
    const url = await manager.getBaseUrl('openai');
    expect(url).toBe('http://localhost:9000/v1');
  });

  test('getBaseUrl returns undefined when no baseUrl was stored', async () => {
    await manager.set('anthropic', ANTH_KEY);
    const url = await manager.getBaseUrl('anthropic');
    expect(url).toBeUndefined();
  });

  test('getBaseUrl returns undefined for provider never set', async () => {
    const url = await manager.getBaseUrl('groq');
    expect(url).toBeUndefined();
  });

  test('getBaseUrl is per-workspace isolated', async () => {
    await manager.set('openai', 'ws1-key', {
      baseUrl: 'http://ws1-endpoint/v1',
    });
    const { meta: meta2 } = await createWorkspaceDir({ name: 'secondws' });
    const urlOther = await manager.getBaseUrl('openai', meta2.id);
    expect(urlOther).toBeUndefined();
    const urlThis = await manager.getBaseUrl('openai', wsId);
    expect(urlThis).toBe('http://ws1-endpoint/v1');
  });
});
