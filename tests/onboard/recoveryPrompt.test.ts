// tests/onboard/recoveryPrompt.test.ts (SPEC-505 v2)

import { afterEach, beforeEach, describe, expect, test, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runRecoveryPrompt, type RecoveryInput } from '../../src/onboard/recoveryPrompt.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];

function makeInput(reason: RecoveryInput['reason'], dir: string): RecoveryInput {
  return { reason, path: dir };
}

describe('SPEC-505: runRecoveryPrompt — non-TTY paths', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-recovery-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
  });

  test('missing_file: returns true (allow boot) regardless of TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('missing_file', tmpRoot), { tty: false });
    expect(result).toBe(true);
  });

  test('missing_file with tty=true still returns true (silent)', async () => {
    const result = await runRecoveryPrompt(makeInput('missing_file', tmpRoot), { tty: true });
    expect(result).toBe(true);
  });

  test('schema_newer: returns false (unresolvable) regardless of TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('schema_newer', tmpRoot), { tty: false });
    expect(result).toBe(false);
  });

  test('schema_newer with tty=true: returns false (cannot fix by re-entering key)', async () => {
    const result = await runRecoveryPrompt(makeInput('schema_newer', tmpRoot), { tty: true });
    expect(result).toBe(false);
  });

  test('decrypt_failed: returns false in non-TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot), { tty: false });
    expect(result).toBe(false);
  });

  test('missing_passphrase: returns false in non-TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('missing_passphrase', tmpRoot), { tty: false });
    expect(result).toBe(false);
  });

  test('corrupt_envelope: returns false in non-TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('corrupt_envelope', tmpRoot), { tty: false });
    expect(result).toBe(false);
  });

  test('schema_old: returns false in non-TTY', async () => {
    const result = await runRecoveryPrompt(makeInput('schema_old', tmpRoot), { tty: false });
    expect(result).toBe(false);
  });

  test('all fixable reasons do not throw in non-TTY', async () => {
    const reasons: RecoveryInput['reason'][] = [
      'missing_file', 'missing_passphrase', 'decrypt_failed',
      'corrupt_envelope', 'schema_old', 'schema_newer',
    ];
    for (const reason of reasons) {
      await expect(
        runRecoveryPrompt(makeInput(reason, tmpRoot), { tty: false }),
      ).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// TTY interactive path tests
// We mock process.stdin with a PassThrough stream marked isTTY=true.
// ---------------------------------------------------------------------------

describe('SPEC-505: runRecoveryPrompt — TTY interactive paths', () => {
  let tmpRoot2: string;
  let originalStdin: NodeJS.ReadStream;
  let interactiveSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    tmpRoot2 = mkdtempSync(join(tmpdir(), 'nimbus-recovery-tty-'));
    process.env['NIMBUS_HOME'] = tmpRoot2;
    originalStdin = process.stdin;
    interactiveSpy = null;
  });

  afterEach(() => {
    interactiveSpy?.mockRestore();
    rmSync(tmpRoot2, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
  });

  function makeStdin(data: string): NodeJS.ReadStream {
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = true;
    setTimeout(() => {
      pt.write(data);
      pt.end();
    }, 0);
    return pt as unknown as NodeJS.ReadStream;
  }

  function replaceStdin(stream: NodeJS.ReadStream): void {
    Object.defineProperty(process, 'stdin', { value: stream, writable: true, configurable: true });
  }

  test('Enter (empty input) → triggers interactive key manager → returns its result', async () => {
    // Vault file exists so backup can proceed
    writeFileSync(join(tmpRoot2, 'secrets.enc'), 'fake-vault-data');
    replaceStdin(makeStdin('\n'));

    // Mock runInteractiveKeyManager to avoid real key/network ops
    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot2), { tty: true });
    expect(result).toBe(true);
    expect(interactiveSpy).toHaveBeenCalledTimes(1);
  });

  test('s (skip) → returns true without calling interactive manager', async () => {
    replaceStdin(makeStdin('s\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot2), { tty: true });
    expect(result).toBe(true);
    expect(interactiveSpy).not.toHaveBeenCalled();
  });

  test('S (uppercase skip) → returns true', async () => {
    replaceStdin(makeStdin('S\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    const result = await runRecoveryPrompt(makeInput('corrupt_envelope', tmpRoot2), { tty: true });
    expect(result).toBe(true);
  });

  test('q (quit) → returns false', async () => {
    replaceStdin(makeStdin('q\n'));

    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot2), { tty: true });
    expect(result).toBe(false);
  });

  test('Q (uppercase quit) → returns false', async () => {
    replaceStdin(makeStdin('Q\n'));

    const result = await runRecoveryPrompt(makeInput('missing_passphrase', tmpRoot2), { tty: true });
    expect(result).toBe(false);
  });

  test('invalid input then skip → re-prompts, then returns true on s', async () => {
    // 'x\n' is invalid → re-prompt; 's\n' → skip
    replaceStdin(makeStdin('x\ns\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot2), { tty: true });
    expect(result).toBe(true);
    expect(interactiveSpy).not.toHaveBeenCalled();
  });

  test('foo (invalid) then q → re-prompts, then returns false on q', async () => {
    replaceStdin(makeStdin('foo\nq\n'));

    const result = await runRecoveryPrompt(makeInput('schema_old', tmpRoot2), { tty: true });
    expect(result).toBe(false);
  });

  test('backup created at secrets.enc.bak-*-corrupt before fix flow', async () => {
    writeFileSync(join(tmpRoot2, 'secrets.enc'), 'fake-vault-bytes');
    replaceStdin(makeStdin('\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    await runRecoveryPrompt(makeInput('corrupt_envelope', tmpRoot2), { tty: true });

    const backups = readdirSync(tmpRoot2).filter((f) => f.match(/^secrets\.enc\.bak-.*-corrupt$/));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  test('backup rotation: 6 corrupt backups → oldest pruned to 5', async () => {
    // Pre-create 6 fake backup files with staggered mtimes
    for (let i = 0; i < 6; i++) {
      const ts = new Date(Date.now() - i * 60_000).toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(tmpRoot2, `secrets.enc.bak-${ts}-corrupt`), `backup-${i}`);
    }
    writeFileSync(join(tmpRoot2, 'secrets.enc'), 'vault-data');
    replaceStdin(makeStdin('\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(0);

    await runRecoveryPrompt(makeInput('corrupt_envelope', tmpRoot2), { tty: true });

    const backups = readdirSync(tmpRoot2).filter((f) => f.match(/^secrets\.enc\.bak-.*-corrupt$/));
    // After adding one more (7 total) and pruning, should have at most 5
    expect(backups.length).toBeLessThanOrEqual(5);
  });

  test('fix flow exit code non-zero → returns false', async () => {
    writeFileSync(join(tmpRoot2, 'secrets.enc'), 'fake-vault-data');
    replaceStdin(makeStdin('\n'));

    const interactiveModule = await import('../../src/key/interactive.ts');
    interactiveSpy = spyOn(interactiveModule, 'runInteractiveKeyManager').mockResolvedValue(2);

    const result = await runRecoveryPrompt(makeInput('decrypt_failed', tmpRoot2), { tty: true });
    expect(result).toBe(false);
  });
});
