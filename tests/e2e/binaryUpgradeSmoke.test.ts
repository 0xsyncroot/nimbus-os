// binaryUpgradeSmoke.test.ts — v0.3.7 URGENT: binary-level smoke coverage for
// the upgrade-with-saved-key regression. Skipped when the compiled binary is
// not present (e.g. unit test runs); run by QA + CD after `bun run compile:*`.
//
// This closes the QA gap that let v0.3.6 ship green: unit tests did not
// exercise the real binary-over-vault flow the user actually hit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BIN = process.env['NIMBUS_TEST_BINARY'] ?? join(
  import.meta.dir,
  '..',
  '..',
  'dist',
  process.platform === 'win32' ? 'nimbus-windows-x64.exe' : `nimbus-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
);

const BIN_EXISTS = existsSync(BIN);

const ROOT = join(tmpdir(), `nimbus-e2e-up-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const KEY_OAI = 'sk-' + 'a'.repeat(45);

interface SpawnResult { code: number | null; stdout: string; stderr: string; }

async function spawnBin(args: string[], env: Record<string, string>, input?: string): Promise<SpawnResult> {
  const proc = Bun.spawn([BIN, ...args], {
    env: { ...process.env, ...env, NIMBUS_HOME: ROOT },
    stdin: input ? new TextEncoder().encode(input) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function initWorkspace(env: Record<string, string>): Promise<void> {
  const r = await spawnBin(
    ['init', '--no-prompt', '--no-chat', '--skip-key', '--name', 'smoke'],
    env,
  );
  if (r.code !== 0) {
    throw new Error(`init failed: code=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  }
}

beforeEach(async () => { await mkdir(ROOT, { recursive: true }); });
afterEach(async () => { await rm(ROOT, { recursive: true, force: true }); });

(BIN_EXISTS ? describe : describe.skip)(`v0.3.7 binary smoke (${BIN})`, () => {
  test('save key with env passphrase, new shell without env → friendly message, no JSON blob, no vault clobber', async () => {
    const envWith    = { NIMBUS_VAULT_PASSPHRASE: 'user-pass', NIMBUS_SECRETS_BACKEND: 'file' };
    const envWithout = { NIMBUS_SECRETS_BACKEND: 'file' };

    await initWorkspace(envWith);

    const setR = await spawnBin(
      ['key', 'set', 'openai', '--key-stdin', '--skip-test'],
      envWith,
      `${KEY_OAI}\n`,
    );
    expect(setR.code).toBe(0);

    const vaultKeyPath = join(ROOT, '.vault-key');
    let vaultKeyBefore = false;
    try { await access(vaultKeyPath); vaultKeyBefore = true; } catch {}
    expect(vaultKeyBefore).toBe(false);

    const listR = await spawnBin(['key', 'list'], envWithout);
    const combined = `${listR.stdout}\n${listR.stderr}`;

    // MUST NOT emit raw JSON blob.
    expect(combined).not.toMatch(/U_MISSING_CONFIG:\s*\{/);
    expect(combined).not.toMatch(/provider_key_missing/);
    // MUST surface a friendly, actionable message.
    expect(combined.toLowerCase()).toMatch(/vault|passphrase|credential/);

    // CRITICAL: no silent .vault-key overwrite.
    let vaultKeyAfter = false;
    try { await access(vaultKeyPath); vaultKeyAfter = true; } catch {}
    expect(vaultKeyAfter).toBe(false);

    // Recovery works with original env.
    const listAgain = await spawnBin(['key', 'list'], envWith);
    expect(listAgain.code).toBe(0);
    expect(listAgain.stdout).toContain('openai');
  });
});
