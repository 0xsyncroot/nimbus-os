// runtime.test.ts — SPEC-808 T2: ChannelRuntime lifecycle.
// Verifies startTelegram() rejects cleanly on missing token / empty allowlist,
// stopTelegram() is idempotent, singleton is process-wide.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSecretStoreCache } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import {
  __resetChannelRuntime,
  getChannelRuntime,
  type StartTelegramOptions,
} from '../../src/channels/runtime.ts';
import {
  addAllowedUserId,
  setTelegramBotToken,
} from '../../src/channels/telegram/config.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { switchWorkspace } from '../../src/core/workspace.ts';
import { createRegistry } from '../../src/tools/registry.ts';
import { createGate, compileRules } from '../../src/permissions/index.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { Provider } from '../../src/ir/types.ts';

function makeFakeProvider(): Provider {
  // Provider is not called in these tests (we exit before runTurn), so a
  // minimal stub suffices.
  return {
    id: 'anthropic',
    capabilities() {
      return {
        maxContextTokens: 200_000,
        promptCaching: 'implicit',
        reasoning: false,
        nativeTools: true,
      };
    },
    async *stream() {
      // never reached
      yield { type: 'message_stop', finishReason: 'stop' } as never;
    },
    async send() {
      throw new Error('not called');
    },
  } as unknown as Provider;
}

function makeStartOpts(wsId: string): StartTelegramOptions {
  return {
    wsId,
    provider: makeFakeProvider(),
    model: 'claude-haiku-4-5-20251001',
    registry: createRegistry(),
    gate: createGate({ rules: compileRules([]), bypassCliFlag: true }),
    cwd: process.cwd(),
  };
}

describe('SPEC-808 T2: ChannelRuntime', () => {
  let workDir: string;
  let wsId: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nimbus-tg-runtime-'));
    process.env['NIMBUS_HOME'] = workDir;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetChannelRuntime();

    const { meta } = await createWorkspaceDir({ name: 'rt-test' });
    wsId = meta.id;
    await switchWorkspace(wsId);

    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await getChannelRuntime().dispose().catch(() => undefined);
    __resetChannelRuntime();
    delete process.env['NIMBUS_HOME'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    await rm(workDir, { recursive: true, force: true });
  });

  test('isTelegramRunning returns false on fresh runtime', () => {
    const rt = getChannelRuntime();
    expect(rt.isTelegramRunning()).toBe(false);
  });

  test('startTelegram throws U_MISSING_CONFIG when no token', async () => {
    const rt = getChannelRuntime();
    try {
      await rt.startTelegram(makeStartOpts(wsId));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      if (err instanceof NimbusError) {
        expect(err.code).toBe(ErrorCode.U_MISSING_CONFIG);
        expect(err.context['reason']).toBe('telegram_bot_token_missing');
      }
    }
  });

  test('startTelegram throws when allowlist empty', async () => {
    await setTelegramBotToken('1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567_-', wsId);
    const rt = getChannelRuntime();
    try {
      await rt.startTelegram(makeStartOpts(wsId));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      if (err instanceof NimbusError) {
        expect(err.code).toBe(ErrorCode.U_MISSING_CONFIG);
        expect(err.context['reason']).toBe('telegram_allowlist_empty');
      }
    }
  });

  test('startTelegram succeeds with mocked getMe + immediately-stoppable', async () => {
    await setTelegramBotToken('1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567_-', wsId);
    await addAllowedUserId(42, wsId);

    // Mock fetch — return getMe success for any call, empty updates for polling.
    globalThis.fetch = (async (url: string | URL | Request, _init?: unknown) => {
      const s = typeof url === 'string' ? url : url.toString();
      if (s.includes('/getMe')) {
        return new Response(
          JSON.stringify({ ok: true, result: { id: 111, username: 'nimbus_test_bot', first_name: 'Nimbus' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (s.includes('/getUpdates')) {
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: null }), { status: 200 });
    }) as typeof fetch;

    const rt = getChannelRuntime();
    const result = await rt.startTelegram(makeStartOpts(wsId));
    expect(result.botUsername).toBe('nimbus_test_bot');
    expect(rt.isTelegramRunning()).toBe(true);
    expect(rt.getTelegramBotUsername()).toBe('nimbus_test_bot');

    await rt.stopTelegram();
    expect(rt.isTelegramRunning()).toBe(false);
  });

  test('stopTelegram is idempotent when not running', async () => {
    const rt = getChannelRuntime();
    await rt.stopTelegram(); // no-op
    await rt.stopTelegram(); // still no-op
    expect(rt.isTelegramRunning()).toBe(false);
  });

  test('getChannelRuntime returns the same singleton', () => {
    const a = getChannelRuntime();
    const b = getChannelRuntime();
    expect(a).toBe(b);
  });
});
