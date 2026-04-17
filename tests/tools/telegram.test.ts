// telegram.test.ts — SPEC-808 T3: ConnectTelegram / Disconnect / Status tools.
// SPEC-833: updated to use ChannelService port (registerChannelService mock).
// Tools no longer import channels/ directly — the port (core/channelPorts) is injected.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetSecretStoreCache } from '../../src/platform/secrets/index.ts';
import { __resetFileFallbackKey } from '../../src/platform/secrets/fileFallback.ts';
import { __resetChannelRuntime } from '../../src/channels/runtime.ts';
import {
  createConnectTelegramTool,
  createDisconnectTelegramTool,
  createTelegramStatusTool,
  setTelegramRuntimeBridge,
} from '../../src/tools/builtin/Telegram.ts';
import {
  addAllowedUserId,
  setTelegramBotToken,
  readSummary,
} from '../../src/channels/telegram/config.ts';
import {
  registerChannelService,
  __resetChannelService,
  type ChannelService,
} from '../../src/core/channelPorts.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { switchWorkspace } from '../../src/core/workspace.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { ErrorCode } from '../../src/observability/errors.ts';
import { logger } from '../../src/observability/logger.ts';
import { createGate, compileRules } from '../../src/permissions/index.ts';
import { createRegistry } from '../../src/tools/registry.ts';

function makeCtx(wsId: string): ToolContext {
  const ac = new AbortController();
  return {
    workspaceId: wsId,
    sessionId: 'test-session',
    turnId: 'test-turn',
    toolUseId: 'test-tu',
    cwd: process.cwd(),
    signal: ac.signal,
    onAbort: () => undefined,
    permissions: createGate({ rules: compileRules([]), bypassCliFlag: true }),
    mode: 'default',
    logger,
  };
}

/**
 * Build a minimal mock ChannelService backed by in-process state.
 * Used to test tools without starting a real Telegram adapter.
 */
function makeMockChannelService(wsId: string): ChannelService {
  let running = false;
  let botUsername: string | null = null;

  return {
    async startTelegram(_wsId) {
      running = true;
      botUsername = 'testbot';
      return { botUsername: 'testbot' };
    },
    async stopTelegram() {
      running = false;
      botUsername = null;
    },
    isTelegramRunning() {
      return running;
    },
    getTelegramBotUsername() {
      return botUsername;
    },
    async getTelegramStatus(queryWsId) {
      const summary = await readSummary(queryWsId ?? wsId);
      return {
        connected: running,
        botUsername: botUsername ?? undefined,
        tokenPresent: summary.tokenPresent,
        allowedUserIds: summary.allowedUserIds,
      };
    },
  };
}

describe('SPEC-808 T3: Telegram tools', () => {
  let workDir: string;
  let wsId: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nimbus-tg-tools-'));
    process.env['NIMBUS_HOME'] = workDir;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetChannelRuntime();
    __resetChannelService();

    const { meta } = await createWorkspaceDir({ name: 'tg-tools' });
    wsId = meta.id;
    await switchWorkspace(wsId);
    setTelegramRuntimeBridge(null);

    // SPEC-833: register mock ChannelService so tools can find the port
    registerChannelService(makeMockChannelService(wsId));
  });

  afterEach(async () => {
    delete process.env['NIMBUS_HOME'];
    delete process.env['NIMBUS_VAULT_PASSPHRASE'];
    delete process.env['NIMBUS_SECRETS_BACKEND'];
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetChannelRuntime();
    __resetChannelService();
    setTelegramRuntimeBridge(null);
    await rm(workDir, { recursive: true, force: true });
  });

  test('TelegramStatus reports offline + no token when fresh', async () => {
    const tool = createTelegramStatusTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.connected).toBe(false);
    expect(res.output.tokenPresent).toBe(false);
    expect(res.output.allowedUserIds).toEqual([]);
  });

  test('TelegramStatus reports tokenPresent:true after set', async () => {
    await setTelegramBotToken('1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567_-', wsId);
    await addAllowedUserId(42, wsId);
    const tool = createTelegramStatusTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.connected).toBe(false);
    expect(res.output.tokenPresent).toBe(true);
    expect(res.output.allowedUserIds).toEqual([42]);
  });

  test('ConnectTelegram fails with U_MISSING_CONFIG when bridge returns null deps', async () => {
    // Wire a no-op bridge that returns null → triggers deps_unavailable error
    setTelegramRuntimeBridge(() => null);

    const tool = createConnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(ErrorCode.U_MISSING_CONFIG);
    expect(res.error.context['reason']).toBe('channel_runtime_deps_unavailable');
  });

  test('ConnectTelegram fails with channel_runtime_not_wired when no bridge', async () => {
    // bridge is null by default (set in beforeEach); mock svc is running=false
    const tool = createConnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(ErrorCode.U_MISSING_CONFIG);
    // SPEC-833: the mock service's startTelegram throws channel_runtime_bridge_required
    // when isTelegramRunning()=false and no bridge is set; but the tool checks
    // runtimeBridge first (after confirming not already running).
    expect(res.error.context['reason']).toBe('channel_runtime_not_wired');
  });

  test('DisconnectTelegram is idempotent and reports wasRunning:false', async () => {
    const tool = createDisconnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.stopped).toBe(true);
    expect(res.output.wasRunning).toBe(false);
  });
});

// Sanity: registry shape check — ensures tool names don't collide with builtins.
describe('SPEC-808: tool name hygiene', () => {
  test('telegram tools register without collision', () => {
    const reg = createRegistry();
    reg.register(createConnectTelegramTool());
    reg.register(createDisconnectTelegramTool());
    reg.register(createTelegramStatusTool());
    expect(reg.get('ConnectTelegram')).toBeDefined();
    expect(reg.get('DisconnectTelegram')).toBeDefined();
    expect(reg.get('TelegramStatus')).toBeDefined();
  });
});
