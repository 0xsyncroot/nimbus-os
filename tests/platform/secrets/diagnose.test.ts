// tests/platform/secrets/diagnose.test.ts (SPEC-505)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { diagnoseVault } from '../../../src/platform/secrets/diagnose.ts';
import { __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../../src/platform/secrets/fileFallback.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetDetectCache } from '../../../src/platform/detect.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];
const originalPass = process.env['NIMBUS_VAULT_PASSPHRASE'];
const originalBackend = process.env['NIMBUS_SECRETS_BACKEND'];

async function writeValidVault(home: string, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(JSON.stringify({ 'nimbus-os': { 'provider:anthropic': 'sk-test' } }));
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    schemaVersion: 1,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ct.toString('base64'),
    tag: tag.toString('hex'),
  };
  await writeFile(join(home, 'secrets.enc'), JSON.stringify(envelope), { encoding: 'utf8' });
}

describe('SPEC-505: diagnoseVault', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-diagnose-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    __resetSecretStoreCache();
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
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    __resetDetectCache();
  });

  test('missing_file when no secrets.enc exists', async () => {
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('missing_file');
  });

  test('missing_passphrase when vault present but no passphrase', async () => {
    await writeValidVault(tmpRoot, 'some-pass');
    // No env passphrase, no .vault-key file
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('missing_passphrase');
  });

  test('ok when vault exists and passphrase correct (env)', async () => {
    const pass = 'correct horse battery staple';
    await writeValidVault(tmpRoot, pass);
    process.env['NIMBUS_VAULT_PASSPHRASE'] = pass;
    const status = await diagnoseVault();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.schemaVersion).toBe(1);
  });

  test('ok when passphrase read from .vault-key file', async () => {
    const pass = 'vault-key-file-passphrase';
    await writeValidVault(tmpRoot, pass);
    await writeFile(join(tmpRoot, '.vault-key'), pass, { encoding: 'utf8' });
    const status = await diagnoseVault();
    expect(status.ok).toBe(true);
  });

  test('decrypt_failed when vault exists but wrong passphrase', async () => {
    await writeValidVault(tmpRoot, 'correct-passphrase');
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'wrong-passphrase';
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('decrypt_failed');
  });

  test('corrupt_envelope when file has invalid JSON', async () => {
    await writeFile(join(tmpRoot, 'secrets.enc'), 'not valid json', { encoding: 'utf8' });
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('corrupt_envelope');
  });

  test('corrupt_envelope when JSON valid but schema mismatch', async () => {
    await writeFile(join(tmpRoot, 'secrets.enc'), JSON.stringify({ foo: 'bar' }), { encoding: 'utf8' });
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'any';
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('corrupt_envelope');
  });

  test('schema_newer when schemaVersion > 1', async () => {
    const pass = 'test-pass';
    await writeValidVault(tmpRoot, pass);
    const raw = await Bun.file(join(tmpRoot, 'secrets.enc')).text();
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    envelope['schemaVersion'] = 99;
    await writeFile(join(tmpRoot, 'secrets.enc'), JSON.stringify(envelope), { encoding: 'utf8' });
    process.env['NIMBUS_VAULT_PASSPHRASE'] = pass;
    const status = await diagnoseVault();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toBe('schema_newer');
  });

  test('never throws — always returns VaultStatus', async () => {
    // Corrupt file, no passphrase, bad home
    process.env['NIMBUS_HOME'] = join(tmpRoot, 'nonexistent', 'deep', 'path');
    const status = await diagnoseVault();
    expect(status).toBeDefined();
    expect('ok' in status).toBe(true);
  });
});
