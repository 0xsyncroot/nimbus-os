// autoProvision.test.ts — SPEC-901 v0.2.1: vault passphrase auto-provision tests
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  autoProvisionPassphrase,
  __resetFileFallbackKey,
  __resetProvisionedPassphrase,
} from '../../../src/platform/secrets/fileFallback.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';

const TMP = join(tmpdir(), `nimbus-autoprov-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  process.env['NIMBUS_HOME'] = TMP;
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
  __resetSecretStoreCache();
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
});

afterEach(async () => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
  __resetSecretStoreCache();
  await rm(TMP, { recursive: true, force: true });
});

describe('SPEC-901 v0.2.1: autoProvisionPassphrase', () => {
  test('env var NIMBUS_VAULT_PASSPHRASE takes priority', async () => {
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'env-secret-passphrase';
    await autoProvisionPassphrase();
    // After calling autoProvision, getPassphrase should succeed (vault ops possible).
    // We can verify by checking no error is thrown when creating a file-fallback store.
    const { createFileFallback } = await import('../../../src/platform/secrets/fileFallback.ts');
    const store = await createFileFallback();
    // Should not throw when setting (passphrase available).
    await expect(store.set('test-service', 'test-account', 'test-value')).resolves.toBeUndefined();
  });

  test('generates and writes .vault-key file when env not set', async () => {
    await autoProvisionPassphrase();
    // .vault-key file should be created.
    const keyFile = join(TMP, '.vault-key');
    const Bun_ = globalThis.Bun;
    const contents = await Bun_.file(keyFile).text();
    expect(contents.trim().length).toBeGreaterThan(20);
  });

  test('second call is idempotent (reads same key)', async () => {
    await autoProvisionPassphrase();
    const keyFile = join(TMP, '.vault-key');
    const Bun_ = globalThis.Bun;
    const first = await Bun_.file(keyFile).text();

    __resetProvisionedPassphrase();
    // Keep the file — second call should read it.
    await autoProvisionPassphrase();
    const second = await Bun_.file(keyFile).text();
    expect(first.trim()).toBe(second.trim());
  });

  test('reads existing .vault-key file on second run', async () => {
    const keyFile = join(TMP, '.vault-key');
    await writeFile(keyFile, 'my-existing-passphrase', { encoding: 'utf8' });

    await autoProvisionPassphrase();

    // Should use the file's passphrase — vault ops work.
    const { createFileFallback } = await import('../../../src/platform/secrets/fileFallback.ts');
    const store = await createFileFallback();
    await expect(store.set('svc', 'acct', 'val')).resolves.toBeUndefined();
  });

  test('vault set/get works after auto-provision', async () => {
    await autoProvisionPassphrase();
    const { createFileFallback } = await import('../../../src/platform/secrets/fileFallback.ts');
    const store = await createFileFallback();
    await store.set('nimbus-keys', 'anthropic', 'sk-ant-test-key');
    const retrieved = await store.get('nimbus-keys', 'anthropic');
    expect(retrieved).toBe('sk-ant-test-key');
  });
});
