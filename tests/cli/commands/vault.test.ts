// tests/cli/commands/vault.test.ts (SPEC-505)

import { afterEach, beforeEach, describe, expect, test, spyOn, mock, type Mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runVault } from '../../../src/cli/commands/vault.ts';
import { __resetDetectCache } from '../../../src/platform/detect.ts';
import { __resetSecretStoreCache } from '../../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../../src/platform/secrets/fileFallback.ts';

let tmpRoot: string;
const originalHome = process.env['NIMBUS_HOME'];
const originalBackend = process.env['NIMBUS_SECRETS_BACKEND'];
const originalStdin = process.stdin;

describe('SPEC-505: runVault', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-vault-cmd-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  test('no subcommand prints help and returns 0', async () => {
    const code = await runVault([]);
    expect(code).toBe(0);
  });

  test('vault status returns 0 or 1 (vault may be absent)', async () => {
    const code = await runVault(['status']);
    expect(code === 0 || code === 1).toBe(true);
  });

  test('vault reset without --yes returns 1 (dry run prompt)', async () => {
    const code = await runVault(['reset']);
    expect(code).toBe(1);
  });

  test('unknown subcommand falls through to help', async () => {
    const code = await runVault(['unknown-subcommand']);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QA BUG fix: vault reset --yes with stdin pipe
// ---------------------------------------------------------------------------
describe('SPEC-505: vault reset --key-stdin (QA BUG)', () => {
  // Pre-import the manager module so we can spy on it consistently
  let managerModule: typeof import('../../../src/key/manager.ts');
  let createManagerSpy: ReturnType<typeof spyOn<typeof managerModule, 'createKeyManager'>>;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-vault-stdin-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-passphrase-vault-reset';
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    managerModule = await import('../../../src/key/manager.ts');
  });

  afterEach(() => {
    // Restore spy if it was set
    createManagerSpy?.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  test('--key-stdin reads key from stdin pipe instead of calling promptApiKey', async () => {
    // Simulate: echo "sk-test-key" | nimbus vault reset --yes --key-stdin
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = false;
    Object.defineProperty(process, 'stdin', {
      value: pt as unknown as NodeJS.ReadStream,
      writable: true,
      configurable: true,
    });
    setTimeout(() => {
      pt.write('sk-test-key-stdin-12345\n');
      pt.end();
    }, 0);

    const setMock = mock(async () => {});
    const testMock = mock(async () => ({ ok: true }));
    createManagerSpy = spyOn(managerModule, 'createKeyManager').mockReturnValue({
      set: setMock,
      test: testMock,
      get: mock(async () => null),
      list: mock(async () => []),
      delete: mock(async () => {}),
      getBaseUrl: mock(async () => undefined),
    } as unknown as ReturnType<typeof managerModule.createKeyManager>);

    const code = await runVault(['reset', '--yes', '--key-stdin']);

    // Should succeed — key read from stdin, km.set called
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    const callArgs = setMock.mock.calls[0] as [string, string, ...unknown[]] | undefined;
    // callArgs[1] is the key
    expect(callArgs?.[1]).toBe('sk-test-key-stdin-12345');
  });

  test('non-TTY stdin without --key-stdin flag: auto-detects pipe and reads from stdin', async () => {
    // When stdin is not a TTY (isNonTTY=true), vault reset should auto-use stdin even without --key-stdin
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = false;
    Object.defineProperty(process, 'stdin', {
      value: pt as unknown as NodeJS.ReadStream,
      writable: true,
      configurable: true,
    });
    setTimeout(() => {
      pt.write('sk-auto-detected-key\n');
      pt.end();
    }, 0);

    const setMock = mock(async () => {});
    createManagerSpy = spyOn(managerModule, 'createKeyManager').mockReturnValue({
      set: setMock,
      test: mock(async () => ({ ok: false })),
      get: mock(async () => null),
      list: mock(async () => []),
      delete: mock(async () => {}),
      getBaseUrl: mock(async () => undefined),
    } as unknown as ReturnType<typeof managerModule.createKeyManager>);

    const code = await runVault(['reset', '--yes']);
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  test('--key-stdin with empty stdin: returns 1 (empty_stdin_key error)', async () => {
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = false;
    Object.defineProperty(process, 'stdin', {
      value: pt as unknown as NodeJS.ReadStream,
      writable: true,
      configurable: true,
    });
    // Send empty content
    setTimeout(() => {
      pt.write('');
      pt.end();
    }, 0);

    const code = await runVault(['reset', '--yes', '--key-stdin']);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider auto-detection + --provider flag tests (QA Round 3)
// ---------------------------------------------------------------------------
describe('SPEC-505: vault reset provider resolution', () => {
  let managerModule: typeof import('../../../src/key/manager.ts');
  let createManagerSpy: ReturnType<typeof spyOn<typeof managerModule, 'createKeyManager'>>;

  function makeStdin(key: string): NodeJS.ReadStream {
    const pt = new PassThrough();
    (pt as unknown as NodeJS.ReadStream).isTTY = false;
    Object.defineProperty(process, 'stdin', {
      value: pt as unknown as NodeJS.ReadStream,
      writable: true,
      configurable: true,
    });
    setTimeout(() => {
      pt.write(`${key}\n`);
      pt.end();
    }, 0);
    return pt as unknown as NodeJS.ReadStream;
  }

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-vault-provres-'));
    process.env['NIMBUS_HOME'] = tmpRoot;
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-passphrase-provres';
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
    managerModule = await import('../../../src/key/manager.ts');
  });

  afterEach(() => {
    createManagerSpy?.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['NIMBUS_HOME'] = originalHome;
    else delete process.env['NIMBUS_HOME'];
    if (originalBackend !== undefined) process.env['NIMBUS_SECRETS_BACKEND'] = originalBackend;
    else delete process.env['NIMBUS_SECRETS_BACKEND'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true, configurable: true });
    __resetDetectCache();
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetProvisionedPassphrase();
  });

  function mockManager(setMock: Mock<() => Promise<void>>): void {
    createManagerSpy = spyOn(managerModule, 'createKeyManager').mockReturnValue({
      set: setMock,
      test: mock(async () => ({ ok: true, latencyMs: 0, costUsd: 0 })),
      list: mock(async () => []),
      delete: mock(async () => {}),
      getBaseUrl: mock(async () => undefined),
    } as unknown as ReturnType<typeof managerModule.createKeyManager>);
  }

  test('sk-ant-* key auto-detects as anthropic', async () => {
    makeStdin('sk-ant-api01-testkey-12345678901234567890');
    const setMock = mock(async () => {});
    mockManager(setMock);

    const code = await runVault(['reset', '--yes', '--key-stdin']);
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [provider] = setMock.mock.calls[0] as unknown as [string, string, ...unknown[]];
    expect(provider).toBe('anthropic');
  });

  test('sk-proj-* key auto-detects as openai', async () => {
    makeStdin('sk-proj-testkey-1234567890123456789012345');
    const setMock = mock(async () => {});
    mockManager(setMock);

    const code = await runVault(['reset', '--yes', '--key-stdin']);
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [provider] = setMock.mock.calls[0] as unknown as [string, string, ...unknown[]];
    expect(provider).toBe('openai');
  });

  test('gsk_* key auto-detects as groq', async () => {
    makeStdin('gsk_testkey1234567890123456789012345678');
    const setMock = mock(async () => {});
    mockManager(setMock);

    const code = await runVault(['reset', '--yes', '--key-stdin']);
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [provider] = setMock.mock.calls[0] as unknown as [string, string, ...unknown[]];
    expect(provider).toBe('groq');
  });

  test('unknown key format without --provider returns 1 with hint', async () => {
    makeStdin('unknown-format-key-that-does-not-match-any-prefix');
    const setMock = mock(async () => {});
    mockManager(setMock);

    // Capture stderr to verify the hint message
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return originalWrite(chunk as Parameters<typeof process.stderr.write>[0], ...(args as Parameters<typeof process.stderr.write>[1][]));
    };

    const code = await runVault(['reset', '--yes', '--key-stdin']);

    process.stderr.write = originalWrite;
    expect(code).toBe(1);
    expect(setMock).not.toHaveBeenCalled();
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('--provider');
  });

  test('--provider openai with sk-proj-* key stores as openai', async () => {
    makeStdin('sk-proj-testkey-1234567890123456789012345');
    const setMock = mock(async () => {});
    mockManager(setMock);

    const code = await runVault(['reset', '--yes', '--key-stdin', '--provider', 'openai']);
    expect(code).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    const [provider] = setMock.mock.calls[0] as unknown as [string, string, ...unknown[]];
    expect(provider).toBe('openai');
  });
});
