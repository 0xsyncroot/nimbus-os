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

// SPEC-309: regression — TelegramStatus from CLI composition root.
// Bug (v0.3.19-alpha): REPL set the tool runtimeBridge but never called
// getChannelRuntime(), so registerChannelService() never fired. Agent saw
// "channel service not available in this context" when invoking TelegramStatus
// from the CLI. Fix = eager `getChannelRuntime()` at REPL startup.
describe('SPEC-309: TelegramStatus after getChannelRuntime bootstrap', () => {
  let workDir: string;
  let wsId: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nimbus-tg-boot-'));
    process.env['NIMBUS_HOME'] = workDir;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetChannelRuntime();
    __resetChannelService();

    const { meta } = await createWorkspaceDir({ name: 'tg-boot' });
    wsId = meta.id;
    await switchWorkspace(wsId);
    setTelegramRuntimeBridge(null);
    // Deliberately DO NOT call registerChannelService() here — we want to
    // prove that getChannelRuntime() does it on our behalf.
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

  test('TelegramStatus returns real status (not fallback stub) after getChannelRuntime()', async () => {
    // Simulate what repl.ts now does at startup (SPEC-309).
    const { getChannelRuntime } = await import('../../src/channels/runtime.ts');
    getChannelRuntime();

    const tool = createTelegramStatusTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Real path: channel service is registered → reports vault-backed truth.
    expect(res.output.connected).toBe(false);
    expect(res.output.tokenPresent).toBe(false);
    expect(res.output.allowedUserIds).toEqual([]);
    // The fallback branch would have produced this display string; ensure
    // we are NOT taking that branch anymore.
    expect(res.display).not.toContain('channel service not available');
    expect(res.display).toContain('Telegram:');
  });

  test('Without getChannelRuntime() the fallback branch still fires (pre-fix shape)', async () => {
    // No bootstrap call → port is null → tool returns the friendly stub.
    const tool = createTelegramStatusTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.display).toContain('channel service not available');
  });
});

// SPEC-311: regression — ConnectTelegram from CLI must flow deps through
// the ChannelService port so the adapter actually starts. Pre-SPEC-311 the
// port's `startTelegram` threw `channel_runtime_bridge_required` for any
// non-running state because the tools-layer bridge deps never left the tool.
describe('SPEC-311: ConnectTelegram bridges deps through ChannelService port', () => {
  let workDir: string;
  let wsId: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'nimbus-tg-bridge-'));
    process.env['NIMBUS_HOME'] = workDir;
    process.env['NIMBUS_VAULT_PASSPHRASE'] = 'test-pass';
    process.env['NIMBUS_SECRETS_BACKEND'] = 'file';
    __resetSecretStoreCache();
    __resetFileFallbackKey();
    __resetChannelRuntime();
    __resetChannelService();

    const { meta } = await createWorkspaceDir({ name: 'tg-bridge' });
    wsId = meta.id;
    await switchWorkspace(wsId);
    setTelegramRuntimeBridge(null);
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

  test('deps from runtimeBridge reach the port.startTelegram(wsId, deps) second arg', async () => {
    // Mock service captures the opaque deps payload.
    let capturedDeps: unknown = undefined;
    let capturedWsId: string | null = null as string | null;
    let running = false;
    registerChannelService({
      async startTelegram(calledWsId, deps) {
        capturedWsId = calledWsId;
        capturedDeps = deps;
        running = true;
        return { botUsername: 'bridgebot' };
      },
      async stopTelegram() {
        running = false;
      },
      isTelegramRunning() {
        return running;
      },
      getTelegramBotUsername() {
        return running ? 'bridgebot' : null;
      },
      async getTelegramStatus(queryWsId) {
        const summary = await readSummary(queryWsId);
        return {
          connected: running,
          botUsername: running ? 'bridgebot' : undefined,
          tokenPresent: summary.tokenPresent,
          allowedUserIds: summary.allowedUserIds,
        };
      },
    });

    // Simulate REPL wiring the bridge with real-shaped deps.
    const deps = {
      provider: { id: 'test', generate: async () => ({}) } as unknown,
      model: 'test-model',
      registry: createRegistry() as unknown,
      gate: createGate({ rules: compileRules([]), bypassCliFlag: true }) as unknown,
      cwd: process.cwd(),
    };
    setTelegramRuntimeBridge(() => deps as never);

    const tool = createConnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.botUsername).toBe('bridgebot');
    expect(res.output.alreadyRunning).toBe(false);
    expect(capturedWsId).toBe(wsId);
    // Critical: port received the deps object. Before SPEC-311 this was `undefined`.
    expect(capturedDeps).toBeDefined();
    expect(capturedDeps).toBe(deps);
  });

  test('already-running fast path still works without deps (idempotent)', async () => {
    let running = true; // start in running state
    registerChannelService({
      async startTelegram(_wsId, _deps) {
        // Port impl MUST short-circuit on already-running without touching deps.
        if (running) return { botUsername: 'alreadybot' };
        throw new Error('should not reach');
      },
      async stopTelegram() {
        running = false;
      },
      isTelegramRunning() {
        return running;
      },
      getTelegramBotUsername() {
        return running ? 'alreadybot' : null;
      },
      async getTelegramStatus(queryWsId) {
        const summary = await readSummary(queryWsId);
        return {
          connected: running,
          botUsername: running ? 'alreadybot' : undefined,
          tokenPresent: summary.tokenPresent,
          allowedUserIds: summary.allowedUserIds,
        };
      },
    });
    // No bridge set → but short-circuit fires before bridge is consulted.
    setTelegramRuntimeBridge(null);

    const tool = createConnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.output.alreadyRunning).toBe(true);
    expect(res.output.botUsername).toBe('alreadybot');
  });

  test('without runtimeBridge surfaces typed channel_runtime_not_wired (not generic bridge_required)', async () => {
    let running = false;
    registerChannelService({
      async startTelegram(_wsId, _deps) {
        throw new Error('should not reach — tool must guard before port');
      },
      async stopTelegram() {
        running = false;
      },
      isTelegramRunning() {
        return running;
      },
      getTelegramBotUsername() {
        return null;
      },
      async getTelegramStatus(queryWsId) {
        const summary = await readSummary(queryWsId);
        return {
          connected: running,
          tokenPresent: summary.tokenPresent,
          allowedUserIds: summary.allowedUserIds,
        };
      },
    });
    setTelegramRuntimeBridge(null);

    const tool = createConnectTelegramTool();
    const res = await tool.handler({}, makeCtx(wsId));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(ErrorCode.U_MISSING_CONFIG);
    // The tool-layer guard fires first with a user-actionable reason; the
    // generic channel_runtime_bridge_required from the port must NOT leak.
    expect(res.error.context['reason']).toBe('channel_runtime_not_wired');
    expect(res.error.context['reason']).not.toBe('channel_runtime_bridge_required');
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
