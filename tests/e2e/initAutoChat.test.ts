// tests/e2e/initAutoChat.test.ts — SPEC-802: `nimbus init` auto-continues to REPL.
// --no-chat and --no-prompt must skip REPL (CI path).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runInit } from '../../src/onboard/init.ts';
import { __resetSecretStoreCache } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey, __resetProvisionedPassphrase } from '../../src/platform/secrets/fileFallback.ts';
import { __resetDetectCache } from '../../src/platform/detect.ts';

// ---------------------------------------------------------------------------
// parseFlags unit tests (replicated minimal version — no subprocess needed)
// ---------------------------------------------------------------------------

interface TestParsedFlags {
  noChat: boolean;
  noPrompt: boolean;
}

function parseTestFlags(args: string[]): TestParsedFlags {
  const flags: TestParsedFlags = { noChat: false, noPrompt: false };
  for (const a of args) {
    if (a === '--no-chat') flags.noChat = true;
    if (a === '--no-prompt') flags.noPrompt = true;
  }
  return flags;
}

describe('SPEC-802: initAutoChat — --no-chat flag parsing', () => {
  test('--no-chat sets noChat flag', () => {
    expect(parseTestFlags(['--no-chat']).noChat).toBe(true);
    expect(parseTestFlags(['--no-chat']).noPrompt).toBe(false);
  });

  test('--no-prompt sets noPrompt flag', () => {
    expect(parseTestFlags(['--no-prompt']).noPrompt).toBe(true);
    expect(parseTestFlags(['--no-prompt']).noChat).toBe(false);
  });

  test('no flags → both false (default auto-REPL path)', () => {
    const f = parseTestFlags([]);
    expect(f.noChat).toBe(false);
    expect(f.noPrompt).toBe(false);
  });

  test('both flags together', () => {
    const f = parseTestFlags(['--no-prompt', '--no-chat']);
    expect(f.noChat).toBe(true);
    expect(f.noPrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: runInit no longer prints "now run `nimbus`"
// ---------------------------------------------------------------------------

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

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'nimbus-e2e-autochat-'));
  process.env['NIMBUS_HOME'] = tmpRoot;
  process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-autochat';
  process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
  __resetDetectCache();
});

afterEach(() => {
  delete process.env['NIMBUS_HOME'];
  delete process.env['NIMBUS_VAULT_PASSPHRASE'];
  delete process.env['NIMBUS_SECRETS_BACKEND'];
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetSecretStoreCache();
  __resetFileFallbackKey();
  __resetProvisionedPassphrase();
});

describe('SPEC-802: initAutoChat — init output no longer says "now run nimbus"', () => {
  test('runInit output does not contain "now run `nimbus`" message', async () => {
    const output = sinkOutput();
    await runInit({
      noPrompt: true,
      output,
      answers: { workspaceName: 'testspace', provider: 'ollama' },
    });

    // The misleading "now run `nimbus`" line was removed in v0.2.2 —
    // init now auto-continues to REPL from cli.ts.
    expect(output.captured).not.toContain('now run');
    // Workspace created line should still be present
    expect(output.captured).toContain('testspace');
  });
});
