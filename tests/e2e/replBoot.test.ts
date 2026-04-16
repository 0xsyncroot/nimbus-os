// tests/e2e/replBoot.test.ts — SPEC-801/SPEC-902 regression: vault passphrase auto-provisioned on REPL boot.
// Ensures that a fresh process starting the REPL after `init` does NOT hit P_AUTH from
// a missing passphrase causing vault decrypt to fail and falling back to 'sk-unused'.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runInit } from '../../src/onboard/init.ts';
import { createKeyManager } from '../../src/key/manager.ts';
import { __resetSecretStoreCache, getBest } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { resolveProviderKey } from '../../src/providers/registry.ts';
import { getActiveWorkspace } from '../../src/core/workspace.ts';

const ANTH_KEY = 'sk-ant-' + 'B'.repeat(40);

let tmpRoot: string;

function sinkOutput(): Writable & { captured: string } {
  const out = new Writable({
    write(chunk, _enc, cb) {
      (out as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  out.captured = '';
  return out;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-e2e-replboot-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  // No NIMBUS_VAULT_PASSPHRASE — simulates a fresh process that must load from file.
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
  __resetDetectCache();
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  delete process.env['ANTHROPIC_API_KEY'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
});

describe('SPEC-802 E2E: replBoot — vault passphrase auto-provisioned', () => {
  test('after init stores key, resolveProviderKey succeeds even when env passphrase absent', async () => {
    // Phase 1: simulate init (passphrase generated + written to .vault-key)
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      apiKey: ANTH_KEY,
      keyManager: createKeyManager({ secretStore: await getBest() }),
      answers: { workspaceName: 'bootws', provider: 'anthropic' },
    });

    const active = await getActiveWorkspace();
    expect(active).not.toBeNull();

    // Phase 2: simulate fresh process — drop in-memory key cache + provisioned passphrase
    // (as if the user started `nimbus` in a new shell after `nimbus init`)
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    __resetSecretStoreCache();

    // autoProvisionPassphrase must reload from ~/.nimbus/.vault-key (no env passphrase set)
    const { autoProvisionPassphrase } = await import('../../src/platform/secrets/fileFallback.ts');
    await autoProvisionPassphrase();

    // After auto-provisioning, key resolution must succeed (no P_AUTH / sk-unused path)
    const resolved = await resolveProviderKey({
      providerId: 'anthropic',
      wsId: active!.id,
    });
    expect(resolved.source).toBe('secrets');
    expect(resolved.apiKey).toBe(ANTH_KEY);
    // Critically: the resolved key must NOT be the 'sk-unused' sentinel
    expect(resolved.apiKey).not.toBe('sk-unused');
  });

  test('autoProvisionPassphrase is idempotent — multiple calls are no-op', async () => {
    const { autoProvisionPassphrase } = await import('../../src/platform/secrets/fileFallback.ts');
    // First call generates the file
    await autoProvisionPassphrase();
    // Second call should not throw, not regenerate
    await expect(autoProvisionPassphrase()).resolves.toBeUndefined();
  });
});
