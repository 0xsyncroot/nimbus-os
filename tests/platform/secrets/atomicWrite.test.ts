// tests/platform/secrets/atomicWrite.test.ts (SPEC-153 §6.1)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileFallback,
  writeAtomic,
  __resetFileFallbackKey,
  __resetProvisionedPassphrase,
} from '../../../src/platform/secrets/fileFallback.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';
import { __resetDetectCache } from '../../../src/platform/detect.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];
const originalPass = process.env['NIMBUS_VAULT_PASSPHRASE'];

function vaultFile(): string {
  return join(tmpRoot, 'secrets.enc');
}

function tmpFile(): string {
  return vaultFile() + '.tmp';
}

function listBakFiles(): Promise<string[]> {
  return readdir(tmpRoot).then((entries) =>
    entries.filter((e) => e.startsWith('secrets.enc.bak-')),
  );
}

describe('SPEC-153: atomic write + backup rotation', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-atomic-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-atomic-pass';
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

  // ── T1: Happy path ──────────────────────────────────────────────────────────
  test('happy path: saveData succeeds, no .tmp leftover, content decrypts', async () => {
    const store = await createFileFallback();
    await store.set('svc', 'acct', 'secret-value');

    // secrets.enc must exist and decrypt correctly.
    const got = await store.get('svc', 'acct');
    expect(got).toBe('secret-value');

    // No .tmp orphan.
    let tmpExists = true;
    try {
      await stat(tmpFile());
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  // ── T2: Crash simulation ────────────────────────────────────────────────────
  // We simulate a crash between tmp-write and rename by attempting writeAtomic
  // with a final path whose PARENT is a file (not a directory), making rename
  // fail deterministically after the tmp file is written.
  test('crash simulation: rename fails → .tmp cleaned, original vault intact', async () => {
    if (process.platform === 'win32') return; // skip on Windows — different rename semantics

    // Establish a valid vault first.
    const store = await createFileFallback();
    await store.set('svc', 'acct', 'original-value');
    const gotBefore = await store.get('svc', 'acct');
    expect(gotBefore).toBe('original-value');

    // Record the original vault content to verify it is unchanged after the failed write.
    const { readFile } = await import('node:fs/promises');
    const originalContent = await readFile(vaultFile(), 'utf8');

    // Attempt writeAtomic to a path where rename WILL fail: final path is a directory.
    // We create a directory at `finalPath` so rename(tmp, finalPath) → EISDIR.
    const badDir = join(tmpRoot, 'bad-target');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(badDir); // rename over a non-empty dir is EISDIR on Linux

    let writeError: unknown;
    const tmpOfBadDir = badDir + '.tmp';
    try {
      await writeAtomic(badDir, 'would-overwrite-dir');
    } catch (err) {
      writeError = err;
    }

    // writeAtomic must have thrown.
    expect(writeError).toBeInstanceOf(NimbusError);
    expect((writeError as NimbusError).code).toBe(ErrorCode.S_STORAGE_CORRUPT);
    expect((writeError as NimbusError).context['reason']).toBe('atomic_write_failed');

    // .tmp must be cleaned up.
    let tmpExists = true;
    try {
      await stat(tmpOfBadDir);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);

    // Original vault must be unchanged.
    const afterContent = await readFile(vaultFile(), 'utf8');
    expect(afterContent).toBe(originalContent);

    // And the vault must still decrypt correctly.
    __resetFileFallbackKey();
    const storeAfter = await createFileFallback();
    const gotAfter = await storeAfter.get('svc', 'acct');
    expect(gotAfter).toBe('original-value');
  });

  // ── T3: Backup rotation ─────────────────────────────────────────────────────
  test('backup rotation: 5 saves → exactly 3 .bak-* files remain', async () => {
    const store = await createFileFallback();

    for (let i = 1; i <= 5; i++) {
      // Small sleep so ISO timestamps differ (1 ms granularity is enough).
      await new Promise((r) => setTimeout(r, 5));
      await store.set('svc', 'counter', String(i));
    }

    const baks = await listBakFiles();
    expect(baks.length).toBe(3);
  });

  // ── T4: Permissions ─────────────────────────────────────────────────────────
  test('permissions: .bak-* files are mode 0o600 on POSIX', async () => {
    if (process.platform === 'win32') return;

    const store = await createFileFallback();
    await store.set('svc', 'acct', 'v1');
    await new Promise((r) => setTimeout(r, 5));
    await store.set('svc', 'acct', 'v2'); // triggers one backup

    const baks = await listBakFiles();
    expect(baks.length).toBeGreaterThanOrEqual(1);

    for (const bak of baks) {
      const s = await stat(join(tmpRoot, bak));
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  // ── T5: First-write no backup ───────────────────────────────────────────────
  test('first-write: fresh vault → no .bak-* files created', async () => {
    const store = await createFileFallback();
    await store.set('svc', 'acct', 'first-value');

    const baks = await listBakFiles();
    expect(baks.length).toBe(0);
  });

  // ── T6: secrets.enc mode 0o600 on POSIX ─────────────────────────────────────
  test('final vault file is mode 0o600 on POSIX', async () => {
    if (process.platform === 'win32') return;

    const store = await createFileFallback();
    await store.set('svc', 'acct', 'v');

    const s = await stat(vaultFile());
    expect(s.mode & 0o777).toBe(0o600);
  });
});
