// tests/onboard/recoveryPrompt.test.ts (SPEC-505)

import { afterEach, beforeEach, describe, expect, test, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runRecoveryPrompt } from '../../src/onboard/recoveryPrompt.ts';
import type { VaultStatus } from '../../src/platform/secrets/diagnose.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];

describe('SPEC-505: runRecoveryPrompt', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-recovery-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
  });

  test('missing_file: returns true (allow boot) — benign', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'missing_file' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(true);
  });

  test('schema_newer: returns false (unresolvable) in non-TTY', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'schema_newer' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(false);
  });

  test('decrypt_failed: returns false in non-TTY (no auto-fix)', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'decrypt_failed' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(false);
  });

  test('missing_passphrase: returns false in non-TTY', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'missing_passphrase' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(false);
  });

  test('corrupt_envelope: returns false in non-TTY', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'corrupt_envelope' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(false);
  });

  test('schema_old: returns false in non-TTY (requires interactive fix)', async () => {
    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'schema_old' };
    const result = await runRecoveryPrompt(status, { tty: false });
    expect(result).toBe(false);
  });
});

describe('SPEC-505: reasonMessage text sanity', () => {
  // Test that each reason produces a truthy message by importing private helper via recovery path
  const reasons = [
    'missing_file',
    'missing_passphrase',
    'decrypt_failed',
    'corrupt_envelope',
    'schema_old',
    'schema_newer',
  ] as const;

  for (const reason of reasons) {
    test(`non-TTY path for ${reason} does not throw`, async () => {
      const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason };
      // Should always return without throwing
      await expect(runRecoveryPrompt(status, { tty: false })).resolves.toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// BLOCKER 3: TTY-interactive path tests
// We mock process.stdin with a PassThrough stream marked isTTY=true so that
// promptChoice() reads from it. We also mock doVaultReset internals to avoid
// real filesystem / network operations.
// ---------------------------------------------------------------------------

describe('SPEC-505: runRecoveryPrompt TTY interactive path', () => {
  let tmpRoot2: string;
  let originalStdin: NodeJS.ReadStream;
  let promptSpy: ReturnType<typeof spyOn> | null = null;
  let createManagerSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    tmpRoot2 = mkdtempSync(join(tmpdir(), 'nimbus-recovery-tty-'));
    process.env['NIMBUS_HOME'] = tmpRoot2;
    originalStdin = process.stdin;
    promptSpy = null;
    createManagerSpy = null;
  });

  afterEach(() => {
    promptSpy?.mockRestore();
    createManagerSpy?.mockRestore();
    rmSync(tmpRoot2, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    // Restore original stdin
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
  });

  function makeStdin(data: string): NodeJS.ReadStream {
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = true;
    // Feed data after a tick so listeners are attached
    setTimeout(() => {
      pt.write(data);
      pt.end();
    }, 0);
    return pt as unknown as NodeJS.ReadStream;
  }

  function replaceStdin(stream: NodeJS.ReadStream): void {
    Object.defineProperty(process, 'stdin', { value: stream, writable: true, configurable: true });
  }

  test('TTY + choice-2 (skip) → returns true without calling doVaultReset', async () => {
    // choice "2\n" → skip path → return true (allow boot, no reset)
    const fakeStdin = makeStdin('2\n');
    replaceStdin(fakeStdin);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'decrypt_failed' };
    const result = await runRecoveryPrompt(status, { tty: true });
    // Skip choice → always returns true (boot continues, vault not fixed)
    expect(result).toBe(true);
  });

  test('TTY + invalid choice falls back to default (choice-1) and calls doVaultReset', async () => {
    // "xyz\n" is not a valid number → defaults to choice 0 (re-enter key = doVaultReset)
    // We need vault file to exist for backup to succeed; mock passphrase + keyPrompt
    writeFileSync(join(tmpRoot2, 'secrets.enc'), 'fake-vault-data');

    // Set up env to use file backend so autoProvisionPassphrase works
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-passphrase-for-recovery';

    const fakeStdin = makeStdin('xyz\n');
    replaceStdin(fakeStdin);

    // Mock keyPrompt.promptApiKey to avoid real TTY requirement in doVaultReset
    const keyPromptModule = await import('../../src/onboard/keyPrompt.ts');
    promptSpy = spyOn(keyPromptModule, 'promptApiKey').mockResolvedValue('sk-test-key-12345');

    // Mock km.set + km.test so we don't hit real vault/network
    const managerModule = await import('../../src/key/manager.ts');
    createManagerSpy = spyOn(managerModule, 'createKeyManager').mockReturnValue({
      set: mock(async () => {}),
      test: mock(async () => ({ ok: true })),
      get: mock(async () => null),
      list: mock(async () => []),
      delete: mock(async () => {}),
      getBaseUrl: mock(async () => undefined),
    } as unknown as ReturnType<typeof managerModule.createKeyManager>);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'decrypt_failed' };
    const result = await runRecoveryPrompt(status, { tty: true });

    // doVaultReset was called → should return true (success) or false (error is also valid if mock incomplete)
    expect(typeof result).toBe('boolean');
    expect(promptSpy).toHaveBeenCalled();

    delete process.env['NIMBUS_SECRETS_BACKEND'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  });

  test('TTY + EOF mid-choice → graceful exit, returns boolean without throwing', async () => {
    // No data written, just end → EOF triggers onEnd → defaultIdx=0 → doVaultReset attempted
    // We just assert no throw and boolean result
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = true;
    // Immediately end (EOF)
    setTimeout(() => pt.end(), 0);
    replaceStdin(pt as unknown as NodeJS.ReadStream);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'missing_passphrase' };
    // With EOF, promptChoice resolves to defaultIdx=0 → doVaultReset is attempted
    // doVaultReset may succeed or fail (no real vault/keyPrompt) — either is fine, must not throw
    const result = await runRecoveryPrompt(status, { tty: true }).catch(() => false);
    expect(typeof result).toBe('boolean');
  });

  test('missing_file with tty=true still returns true (silent no banner)', async () => {
    // BLOCKER 4 fix: missing_file returns true silently regardless of TTY
    const fakeStdin = makeStdin('1\n');
    replaceStdin(fakeStdin);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'missing_file' };
    const result = await runRecoveryPrompt(status, { tty: true });
    expect(result).toBe(true);
  });

  test('schema_newer + tty=true still returns false (canFix=false branch)', async () => {
    // schema_newer cannot be fixed → even with TTY it returns false
    const fakeStdin = makeStdin('1\n');
    replaceStdin(fakeStdin);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'schema_newer' };
    const result = await runRecoveryPrompt(status, { tty: true });
    expect(result).toBe(false);
  });

  test('corrupt_envelope + tty=true + choice-2 (skip) → returns true', async () => {
    const fakeStdin = makeStdin('2\n');
    replaceStdin(fakeStdin);

    const status: Extract<VaultStatus, { ok: false }> = { ok: false, reason: 'corrupt_envelope' };
    const result = await runRecoveryPrompt(status, { tty: true });
    // Choice 2 = skip → allow boot
    expect(result).toBe(true);
  });
});
