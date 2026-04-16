// tests/cli/commands/doctor.test.ts (SPEC-505)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../../src/cli/commands/doctor.ts';
import { __resetDetectCache } from '../../../src/platform/detect.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../../src/platform/secrets/fileFallback.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];
const originalPass = process.env['NIMBUS_VAULT_PASSPHRASE'];
const originalBackend = process.env['NIMBUS_SECRETS_BACKEND'];

describe('SPEC-505: runDoctor', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-doctor-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalPass !== undefined) process.env['NIMBUS_VAULT_PASSPHRASE'] = originalPass;
    else delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  test('returns number (exit code)', async () => {
    const code = await runDoctor();
    expect(typeof code).toBe('number');
  });

  test('exit code 1 when no workspace and no vault', async () => {
    // No workspace.json, no secrets.enc → issues found
    const code = await runDoctor();
    expect(code).toBe(1);
  });

  test('does not throw', async () => {
    await expect(runDoctor()).resolves.toBeDefined();
  });
});
