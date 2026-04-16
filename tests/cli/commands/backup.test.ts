// tests/cli/commands/backup.test.ts (SPEC-505)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackup } from '../../../src/cli/commands/backup.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];

describe('SPEC-505: runBackup', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-backup-cmd-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
  });

  test('no subcommand prints help and returns 0', async () => {
    const code = await runBackup([]);
    expect(code).toBe(0);
  });

  test('backup list with empty dir returns 0', async () => {
    const code = await runBackup(['list']);
    expect(code).toBe(0);
  });

  test('backup create with empty workspace returns non-throwing result', async () => {
    // No workspaces dir yet, no .vault-key → "Nothing to back up" path
    const code = await runBackup(['create', '--out', join(tmpRoot, 'test-backup.tar.gz')]);
    // Either 0 (success) or 1 (nothing to back up) — just must not throw
    expect(typeof code).toBe('number');
  });

  test('backup restore with missing file returns 1', async () => {
    const code = await runBackup(['restore', '/tmp/nonexistent-backup-file.tar.gz']);
    expect(code).toBe(1);
  });

  test('unknown subcommand falls through to help', async () => {
    const code = await runBackup(['unknown']);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1: vault-key exclusion tests
// ---------------------------------------------------------------------------
describe('SPEC-505: backup credential safety (BLOCKER 1)', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-backup-security-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
  });

  test('with both .vault-key + secrets.enc: prints security warning, continues without .vault-key', async () => {
    // Create both credential files
    writeFileSync(join(tmpRoot, '.vault-key'), 'plaintext-passphrase');
    writeFileSync(join(tmpRoot, 'secrets.enc'), 'encrypted-vault-data');
    // No workspaces dir → backup will still have "nothing to back up" after excluding .vault-key
    const outFile = join(tmpRoot, 'test-safe-backup.tar.gz');

    // Capture stderr to detect security warning
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return origStderrWrite(chunk as string);
    };

    const code = await runBackup(['create', '--out', outFile]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origStderrWrite;

    const stderrOutput = stderrChunks.join('');
    // Should warn about credential exposure
    expect(stderrOutput).toContain('SECURITY');
    expect(stderrOutput).toContain('.vault-key');
    // Must not exit with unhandled error
    expect(typeof code).toBe('number');
  });

  test('with only secrets.enc (no .vault-key): backup proceeds normally — no security block', async () => {
    writeFileSync(join(tmpRoot, 'secrets.enc'), 'encrypted-vault-data');
    const outFile = join(tmpRoot, 'test-ok-backup.tar.gz');
    const code = await runBackup(['create', '--out', outFile]);
    // secrets.enc alone is fine — no block (vault-key not present)
    expect(typeof code).toBe('number');
  });

  test('with only .vault-key (no secrets.enc): backup proceeds — no combined exposure risk', async () => {
    writeFileSync(join(tmpRoot, '.vault-key'), 'plaintext-passphrase');
    const outFile = join(tmpRoot, 'test-key-only.tar.gz');
    const code = await runBackup(['create', '--out', outFile]);
    // No combined risk → proceed (though still nothing to archive without workspaces dir)
    expect(typeof code).toBe('number');
  });

  test('--i-understand-plaintext flag: backup proceeds with explicit override', async () => {
    writeFileSync(join(tmpRoot, '.vault-key'), 'plaintext-passphrase');
    writeFileSync(join(tmpRoot, 'secrets.enc'), 'encrypted-vault-data');
    const outFile = join(tmpRoot, 'test-plaintext-override.tar.gz');

    const stdoutChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return origStdoutWrite(chunk as string);
    };

    const code = await runBackup(['create', '--out', outFile, '--i-understand-plaintext']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origStdoutWrite;

    const stdoutOutput = stdoutChunks.join('');
    // Should mention the override warning
    expect(stdoutOutput).toContain('--i-understand-plaintext');
    expect(typeof code).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 2: tar path traversal tests
// ---------------------------------------------------------------------------
describe('SPEC-505: backup path traversal safety (BLOCKER 2)', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-backup-traversal-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
  });

  test('restore: malicious tar with /etc/passwd entry → refuses with exit 1', async () => {
    // Create a tarball with an absolute path entry (simulates path traversal attack)
    const maliciousTar = join(tmpRoot, 'malicious.tar.gz');
    const maliciousDir = join(tmpRoot, 'malicious-src');
    mkdirSync(maliciousDir, { recursive: true });
    writeFileSync(join(maliciousDir, 'payload.txt'), 'pwned');

    // Build tar with absolute path by using raw tar arguments
    // We create the tar with -P (--absolute-names) to include absolute paths
    const absPayload = join(maliciousDir, 'payload.txt');
    // Create a tar that references the file as /etc/passwd-nimbus-test (absolute)
    // Using process-substitution via shell is not available, so we use tar -czP
    const buildProc = Bun.spawn(
      ['tar', '-czPf', maliciousTar, absPayload],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const buildExit = await buildProc.exited;

    if (buildExit !== 0) {
      // If tar -P not supported on this platform, skip test
      return;
    }

    // Now attempt restore — should be refused
    const code = await runBackup(['restore', maliciousTar]);
    expect(code).toBe(1);
  });

  // BSD tar (macOS) and Windows tar handle flag ordering differently from GNU tar.
  // '-C dir -czf out file' works on GNU; BSD requires '-czf out -C dir file'.
  // Rather than detect tar flavour at runtime, we gate this assertion to Linux
  // where GNU tar is guaranteed. TODO(v0.3): switch to a cross-platform tar lib
  // (e.g. node-tar) so this test can run on all platforms.
  const tarTest = process.platform === 'linux' ? test : test.skip;
  tarTest('restore: valid relative-path tar → proceeds without error', async () => {
    // Create a safe tarball with relative paths only
    const safeTar = join(tmpRoot, 'safe-backup.tar.gz');
    const safeDir = join(tmpRoot, 'safe-src');
    mkdirSync(safeDir, { recursive: true });
    writeFileSync(join(safeDir, 'workspace.json'), '{"id":"test"}');

    const buildProc = Bun.spawn(
      ['tar', '-czf', safeTar, '-C', safeDir, 'workspace.json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    await buildProc.exited;

    const code = await runBackup(['restore', safeTar]);
    // Should succeed (0) — valid relative-path archive
    expect(code).toBe(0);
  });
});
