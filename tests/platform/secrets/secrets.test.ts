// tests/platform/secrets/secrets.test.ts (SPEC-152 §6.1)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSecretStoreCache, getBest, redactSecret } from '../../../src/platform/secrets/index.ts';
import { createFileFallback, __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../../src/platform/secrets/fileFallback.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';
import { __resetDetectCache } from '../../../src/platform/detect.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];
const originalPass = process.env['NIMBUS_VAULT_PASSPHRASE'];
const originalBackend = process.env['NIMBUS_SECRETS_BACKEND'];

describe('SPEC-152: SecretStore', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-secrets-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'correct horse battery staple';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetDetectCache();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalPass !== undefined) process.env['NIMBUS_VAULT_PASSPHRASE'] = originalPass;
    else delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetDetectCache();
  });

  test('env override selects file-fallback', async () => {
    const store = await getBest();
    expect(store.backend).toBe('file-fallback');
  });

  test('set/get round-trip', async () => {
    const store = await getBest();
    await store.set('nimbus-os', 'anthropic', 'sk-ant-test-xyz');
    const got = await store.get('nimbus-os', 'anthropic');
    expect(got).toBe('sk-ant-test-xyz');
  });

  test('delete then get throws T_NOT_FOUND', async () => {
    const store = await getBest();
    await store.set('nimbus-os', 'acct', 'v1');
    await store.delete('nimbus-os', 'acct');
    try {
      await store.get('nimbus-os', 'acct');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_NOT_FOUND);
    }
  });

  test('list returns account names only', async () => {
    const store = await getBest();
    await store.set('nimbus-os', 'a1', 'v1');
    await store.set('nimbus-os', 'a2', 'v2');
    const accounts = await store.list('nimbus-os');
    expect(accounts.sort()).toEqual(['a1', 'a2']);
  });
});

describe('SPEC-152: file fallback', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-ff-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass-A';
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    __resetDetectCache();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalPass !== undefined) process.env['NIMBUS_VAULT_PASSPHRASE'] = originalPass;
    else delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    __resetDetectCache();
  });

  test('vault file created with 0600 on unix', async () => {
    if (process.platform === 'win32') return;
    const store = await createFileFallback();
    await store.set('nimbus-os', 'acct', 'v');
    const vaultFile = join(tmpRoot, 'secrets.enc');
    const st = await stat(vaultFile);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('plaintext never written', async () => {
    const store = await createFileFallback();
    await store.set('nimbus-os', 'anthropic', 'sk-ant-topsecret-XYZ');
    const vaultFile = join(tmpRoot, 'secrets.enc');
    const raw = await readFile(vaultFile, 'utf8');
    expect(raw.includes('sk-ant-topsecret-XYZ')).toBe(false);
    expect(raw.includes('anthropic')).toBe(false);
  });

  test('wrong passphrase throws X_CRED_ACCESS tag_verify_fail', async () => {
    const storeA = await createFileFallback();
    await storeA.set('nimbus-os', 'acct', 'v1');
    __resetFileFallbackKey();
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'wrong-pass';
    const storeB = await createFileFallback();
    try {
      await storeB.get('nimbus-os', 'acct');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_CRED_ACCESS);
      expect((err as NimbusError).context['reason']).toBe('tag_verify_fail');
    }
  });

  test('tampered ciphertext throws X_CRED_ACCESS', async () => {
    const store = await createFileFallback();
    await store.set('nimbus-os', 'acct', 'v1');
    const vaultFile = join(tmpRoot, 'secrets.enc');
    const raw = await readFile(vaultFile, 'utf8');
    const env = JSON.parse(raw) as { ciphertext: string };
    const buf = Buffer.from(env.ciphertext, 'base64');
    buf[0] = buf[0] !== undefined ? buf[0] ^ 0xff : 0xff;
    env.ciphertext = buf.toString('base64');
    await writeFile(vaultFile, JSON.stringify(env));
    __resetFileFallbackKey();
    const store2 = await createFileFallback();
    try {
      await store2.get('nimbus-os', 'acct');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_CRED_ACCESS);
    }
  });

  test('oversized vault throws S_STORAGE_CORRUPT', async () => {
    const vaultFile = join(tmpRoot, 'secrets.enc');
    const big = 'x'.repeat(1_048_577);
    await writeFile(vaultFile, big);
    if (process.platform !== 'win32') await chmod(vaultFile, 0o600);
    const store = await createFileFallback();
    try {
      await store.get('nimbus-os', 'acct');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.S_STORAGE_CORRUPT);
    }
  });

  test('missing passphrase throws U_MISSING_CONFIG', async () => {
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    __resetFileFallbackKey();
    const store = await createFileFallback();
    try {
      await store.set('nimbus-os', 'acct', 'v');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_MISSING_CONFIG);
    }
  });
});

describe('SPEC-152: redaction', () => {
  test('redacts sk-ant prefix', () => {
    expect(redactSecret('sk-ant-api03-abcDEF123')).toBe('sk-ant-***');
  });
  test('redacts sk- prefix', () => {
    expect(redactSecret('sk-abcdef123')).toBe('sk-***');
  });
  test('redacts ghp_ prefix', () => {
    expect(redactSecret('ghp_abcDEF123456')).toBe('ghp_***');
  });
  test('redacts xai- prefix', () => {
    expect(redactSecret('xai-abcdef')).toBe('xai-***');
  });
  test('unknown value falls back to generic mask', () => {
    expect(redactSecret('randomvalue123')).toBe('ran***');
  });
});
