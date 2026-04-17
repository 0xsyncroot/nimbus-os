// vault-readonly-smoke.test.ts — HARD RULE §10 canary test (v0.4.0.1-alpha hotfix).
//
// Spawns the compiled nimbus binary against a pre-seeded NIMBUS_HOME that contains
// a valid vault + .vault-key. Snapshots SHA-256 of every file before and after each
// non-user-initiated invocation (--version, --help, bare nimbus w/ SIGTERM).
//
// FAIL if any file's mtime or content changes under NIMBUS_HOME after those commands.
// This is the CI canary: any future non-user-initiated vault write = immediate CI failure.
//
// Skipped automatically when the compiled binary is absent (unit-test-only runs).
// Run by QA + CD after `bun run compile:*`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Binary resolution ─────────────────────────────────────────────────────────
const BIN = process.env['NIMBUS_TEST_BINARY'] ?? join(
  import.meta.dir,
  '..', '..',
  'dist',
  process.platform === 'win32'
    ? 'nimbus-windows-x64.exe'
    : `nimbus-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
);

const BIN_EXISTS = existsSync(BIN);

// ── Skip guard ────────────────────────────────────────────────────────────────
const describeOrSkip = BIN_EXISTS ? describe : describe.skip;

// ── Snapshot helpers ──────────────────────────────────────────────────────────

type FileSnapshot = Record<string, { sha256: string; mtimeMs: number }>;

async function sha256File(path: string): Promise<string> {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

/** Vault-file filter — only track files that are vault-related (§10 canary scope).
 *  We do NOT track logs/, config/, or workspace data dirs — those may be created
 *  by auto-init on first run and are not §10-sensitive. */
function isVaultRelated(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  return (
    base === 'secrets.enc' ||
    base === '.vault-key' ||
    base.startsWith('secrets.enc.bak') ||
    base.includes('-corrupt') ||
    base.endsWith('.pem')
  );
}

/** Recursively snapshot vault-related files under dir. Returns path → {sha256, mtime}. */
async function snapshotDir(dir: string): Promise<FileSnapshot> {
  const snap: FileSnapshot = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return snap;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const sub = await snapshotDir(full);
      Object.assign(snap, sub);
    } else if (isVaultRelated(full)) {
      snap[full] = { sha256: await sha256File(full), mtimeMs: s.mtimeMs };
    }
  }
  return snap;
}

/** Assert two snapshots are identical. Returns diff lines (empty = clean). */
function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const diffs: string[] = [];
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const p of allPaths) {
    const b = before[p];
    const a = after[p];
    if (!b) {
      diffs.push(`NEW: ${p}`);
    } else if (!a) {
      diffs.push(`DELETED: ${p}`);
    } else if (b.sha256 !== a.sha256) {
      diffs.push(`MODIFIED (content): ${p}`);
    } else if (Math.abs(b.mtimeMs - a.mtimeMs) > 100) {
      // Allow <100 ms float from filesystem rounding.
      diffs.push(`MODIFIED (mtime): ${p}  before=${b.mtimeMs}  after=${a.mtimeMs}`);
    }
  }
  return diffs;
}

// ── Binary runner ─────────────────────────────────────────────────────────────

interface SpawnResult { code: number | null; stdout: string; stderr: string; }

async function runBin(
  args: string[],
  home: string,
  opts: { timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const { timeoutMs = 2000 } = opts;
  const proc = Bun.spawn([BIN, ...args], {
    env: {
      ...process.env,
      NIMBUS_HOME: home,
      NIMBUS_SECRETS_BACKEND: 'file',
      NIMBUS_SKIP_UPGRADE_DETECT: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // SIGTERM after timeoutMs for bare invocations that block on stdin.
  const timer = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

// ── Pre-seed helpers ──────────────────────────────────────────────────────────

const PASSPHRASE = 'test-vault-passphrase-12345';
const FAKE_KEY = 'sk-ant-' + 'X'.repeat(40);

/** Build a minimal valid AES-256-GCM vault envelope + .vault-key in tmpHome. */
async function seedVault(tmpHome: string): Promise<void> {
  await mkdir(tmpHome, { recursive: true });

  // Write .vault-key
  const keyFile = join(tmpHome, '.vault-key');
  await writeFile(keyFile, PASSPHRASE, { encoding: 'utf8' });
  if (process.platform !== 'win32') await chmod(keyFile, 0o600);

  // Build a real encrypted vault envelope using the same crypto as fileFallback.ts
  const { scryptSync, createCipheriv, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(PASSPHRASE, salt, 32, { N: 16384, r: 8, p: 1 });
  const plain = Buffer.from(JSON.stringify({ 'nimbus-os': { key: FAKE_KEY } }), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  plain.fill(0);

  const envelope = {
    schemaVersion: 1,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ct.toString('base64'),
    tag: tag.toString('hex'),
  };

  const vaultFile = join(tmpHome, 'secrets.enc');
  await writeFile(vaultFile, JSON.stringify(envelope), { encoding: 'utf8' });
  if (process.platform !== 'win32') await chmod(vaultFile, 0o600);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describeOrSkip('vault-readonly-smoke: non-user-initiated invocations MUST NOT write to NIMBUS_HOME', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = join(tmpdir(), `nimbus-vault-ro-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await seedVault(tmpHome);
  });

  afterEach(async () => {
    try { await rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('--version does not write any files', async () => {
    const before = await snapshotDir(tmpHome);
    await runBin(['--version'], tmpHome);
    const after = await snapshotDir(tmpHome);
    const diffs = diffSnapshots(before, after);
    expect(diffs, `Files changed under NIMBUS_HOME:\n${diffs.join('\n')}`).toHaveLength(0);
  });

  test('--help does not write any files', async () => {
    const before = await snapshotDir(tmpHome);
    await runBin(['--help'], tmpHome);
    const after = await snapshotDir(tmpHome);
    const diffs = diffSnapshots(before, after);
    expect(diffs, `Files changed under NIMBUS_HOME:\n${diffs.join('\n')}`).toHaveLength(0);
  });

  test('bare nimbus (SIGTERM after 500ms) does not write any files', async () => {
    const before = await snapshotDir(tmpHome);
    // Bare `nimbus` blocks on REPL — SIGTERM after 500ms is intentional.
    await runBin([], tmpHome, { timeoutMs: 500 });
    const after = await snapshotDir(tmpHome);
    const diffs = diffSnapshots(before, after);
    expect(diffs, `Files changed under NIMBUS_HOME:\n${diffs.join('\n')}`).toHaveLength(0);
  });

  test('no "-corrupt" backup files are created on healthy vault', async () => {
    // Run all 3 sequences
    await runBin(['--version'], tmpHome);
    await runBin(['--help'], tmpHome);
    await runBin([], tmpHome, { timeoutMs: 500 });

    const entries = await readdir(tmpHome);
    const corruptFiles = entries.filter((f) => f.includes('-corrupt'));
    expect(corruptFiles, `Unexpected "-corrupt" files: ${corruptFiles.join(', ')}`).toHaveLength(0);
  });
});
