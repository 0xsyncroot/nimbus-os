// tests/e2e/init-with-key.test.ts (SPEC-902 §6.2)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runInit } from '../../src/onboard/init.ts';
import {
  createKeyManager,
  type KeyManager,
} from '../../src/key/manager.ts';
import { __resetSecretStoreCache, getBest } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';
import { resolveProviderKey } from '../../src/providers/registry.ts';
import { getActiveWorkspace } from '../../src/core/workspace.ts';

const ANTH_KEY = 'sk-ant-' + 'A'.repeat(40);

let tmpRoot: string;
let manager: KeyManager;

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-e2e-init-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'e2e-init-passphrase';
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetDetectCache();
  manager = createKeyManager({ secretStore: await getBest() });
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  delete process.env['ANTHROPIC_API_KEY'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
});

describe('SPEC-902 E2E: init → key → resolve', () => {
  test('init with apiKey stores key in secret store', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      apiKey: ANTH_KEY,
      keyManager: manager,
      answers: { workspaceName: 'mainws', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();
    expect(active).not.toBeNull();
    const entries = await manager.list(active!.id);
    expect(entries.length).toBe(1);
    expect(entries[0]?.provider).toBe('anthropic');
    // captured output never leaks raw key
    expect(output.captured).not.toContain(ANTH_KEY);
  });

  test('init with --no-prompt and no apiKey skips key step (logged only)', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      keyManager: manager,
      answers: { workspaceName: 'noprompt', provider: 'anthropic' },
    });
    expect(output.captured).toContain('no key provided');
  });

  test('ollama provider skips key step entirely', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      keyManager: manager,
      answers: { workspaceName: 'localllm', provider: 'ollama' },
    });
    const active = await getActiveWorkspace();
    const entries = await manager.list(active!.id);
    expect(entries.length).toBe(0);
    expect(output.captured).not.toContain('no key provided');
  });

  test('resolveProviderKey falls back through env → secrets → error chain', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      apiKey: ANTH_KEY,
      keyManager: manager,
      answers: { workspaceName: 'chainws', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();
    expect(active).not.toBeNull();

    // env wins over secrets
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-env-xxxxxxxxxxxxxxxxxxxx';
    const fromEnv = await resolveProviderKey({
      providerId: 'anthropic',
      wsId: active!.id,
    });
    expect(fromEnv.source).toBe('env');
    expect(fromEnv.apiKey).toBe('sk-ant-from-env-xxxxxxxxxxxxxxxxxxxx');

    delete process.env['ANTHROPIC_API_KEY'];

    // without env, falls through to secrets
    const fromSecrets = await resolveProviderKey({
      providerId: 'anthropic',
      wsId: active!.id,
    });
    expect(fromSecrets.source).toBe('secrets');
    expect(fromSecrets.apiKey).toBe(ANTH_KEY);

    // CLI flag wins above all
    const fromCli = await resolveProviderKey({
      providerId: 'anthropic',
      wsId: active!.id,
      cliKey: 'sk-ant-cli-' + 'C'.repeat(30),
    });
    expect(fromCli.source).toBe('cli');
  });

  test('resolveProviderKey throws U_MISSING_CONFIG with actionable hint when nothing configured', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      keyManager: manager,
      answers: { workspaceName: 'emptyws', provider: 'anthropic' },
    });
    const active = await getActiveWorkspace();
    let err: unknown = null;
    try {
      await resolveProviderKey({ providerId: 'anthropic', wsId: active!.id });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('U_MISSING_CONFIG');
    expect(String((err as { context: { hint: string } }).context.hint)).toContain('nimbus key set');
  });
});
