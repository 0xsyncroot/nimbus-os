// repl.ts — SPEC-851 T1/T4: startRepl() dispatcher.
// Routes to Ink UI path (default) or legacy readline path (NIMBUS_UI=legacy).
// Legacy path deprecated in v0.4.0 — scheduled for deletion in v0.4.1.
//
// CRITICAL: NIMBUS_UI=legacy detection happens BEFORE any Ink/React import
// so that the legacy path adds zero overhead when the env var is set.

import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { getActiveWorkspace } from '../../core/workspace.ts';
import { loadWorkspace } from '../../storage/workspaceStore.ts';
// eslint-disable-next-line import/no-restricted-paths -- TODO(SPEC-830): repl is the composition root; tool registry injected here until UIHost contract ships
import { createDefaultRegistry, createLoopAdapter } from '../../tools/index.ts';
import { createGate, compileRules } from '../../permissions/index.ts';
import { wireBusSubscribers } from './subscriptions.ts';
import { getChannelRuntime } from '../runtime.ts';
import { formatBootError } from './errorFormatCli.ts';
import { persistBootMeta } from '../../core/workspace.ts';
import { registerDefaultCommands, __resetRegistry } from './slashCommands.ts';
// eslint-disable-next-line import/no-restricted-paths -- composition root: Telegram bridge wired here
import { setTelegramRuntimeBridge } from '../../tools/builtin/Telegram.ts';
import type { UIHost } from '../../core/ui/index.ts';

// Extended UIHost type matching loopAdapter contract
type LoopUIHost = UIHost & { canAsk(): boolean };

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface ReplOptions {
  workspaceId?: string;
  profile?: string;
  skipPermissions?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Re-export for legacy path compatibility and test imports
export { makeOnAsk, parseConfirmAnswer } from './repl.legacy.ts';

// ── startRepl — SPEC-851 T1 ────────────────────────────────────────────────────

/**
 * Start the REPL. Mounts Ink <App> unless NIMBUS_UI=legacy.
 * Does not return until the session ends (Ctrl-C or /exit).
 */
export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  // SPEC-851 §3: legacy detection before any Ink import — no React overhead in legacy mode.
  const useInk = !process.env['NIMBUS_UI'] || process.env['NIMBUS_UI'] === 'ink';
  if (!useInk) {
    const { startReplLegacy } = await import('./repl.legacy.ts');
    return startReplLegacy(opts);
  }

  return startReplInk(opts);
}

// ── startReplInk — Ink path ────────────────────────────────────────────────────

async function startReplInk(opts: ReplOptions = {}): Promise<void> {
  // v0.3.7 fix: auto-provision vault passphrase on boot; surface X_CRED_ACCESS early.
  {
    const { autoProvisionPassphrase } = await import('../../platform/secrets/fileFallback.ts');
    try {
      await autoProvisionPassphrase();
    } catch (err) {
      if (err instanceof NimbusError && err.code === ErrorCode.X_CRED_ACCESS) {
        const formatted = formatBootError({ code: err.code, context: err.context }, 'vi');
        process.stderr.write(`[nimbus] ${formatted.line}\n`);
        if (formatted.hint) process.stderr.write(`[nimbus]   → ${formatted.hint}\n`);
      }
      // Other errors (no workspace yet) → silently continue; init handles them.
    }
  }

  // ── Workspace resolution ───────────────────────────────────────────────────
  let wsId = opts.workspaceId;
  if (!wsId) {
    const active = await getActiveWorkspace();
    if (!active) {
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
        reason: 'no_active_workspace',
        hint: 'run `nimbus init` first',
      });
    }
    wsId = active.id;
  }

  const loaded = await loadWorkspace(wsId);
  const mode = opts.skipPermissions ? 'bypass' : 'default';

  if (opts.skipPermissions) {
    if (process.env['NIMBUS_BYPASS_CONFIRMED'] !== '1') {
      process.stderr.write('[nimbus] --dangerously-skip-permissions requires NIMBUS_BYPASS_CONFIRMED=1\n');
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'bypass_not_confirmed' });
    }
    process.stderr.write('[nimbus] permissions bypass enabled — destructive actions will NOT prompt\n');
  }

  // ── Slash commands + bus ───────────────────────────────────────────────────
  __resetRegistry();
  registerDefaultCommands();
  const unwireBus = wireBusSubscribers({ workspaceId: loaded.meta.id, channel: 'cli' });

  // Eagerly materialise ChannelRuntime so tools can use ChannelService port
  getChannelRuntime();

  // ── Tool registry + gate ──────────────────────────────────────────────────
  const registry = createDefaultRegistry({ includeBash: true, includeMemory: true });
  const gate = createGate({ rules: compileRules([]), bypassCliFlag: opts.skipPermissions === true });

  // ── Boot meta ─────────────────────────────────────────────────────────────
  let bootedMeta = loaded.meta;
  try { bootedMeta = await persistBootMeta(loaded.meta.id); } catch { /* non-fatal */ }

  // ── WorkspaceSummary for Ink ──────────────────────────────────────────────
  const workspace = {
    id: loaded.meta.id,
    name: loaded.meta.name,
    defaultProvider: loaded.meta.defaultProvider,
    defaultModel: loaded.meta.defaultModel,
  };

  // ── Shared UIHost slot — set after Ink mounts ──────────────────────────────
  let inkUIHost: LoopUIHost | undefined;

  // ── Ink mount ─────────────────────────────────────────────────────────────
  const { mountReplApp } = await import('./ink/repl.tsx');

  // We need a submit handler that runs a turn via the loop adapter.
  // Provider is lazy-loaded on first submit so startup stays fast.
  let providerCache: import('../../ir/types.ts').Provider | null = null;

  async function getProvider(): Promise<import('../../ir/types.ts').Provider> {
    if (providerCache) return providerCache;
    const { createProviderFromConfig } = await import('../../providers/registry.ts');
    const providerId = loaded.meta.defaultProvider === 'anthropic' ? 'anthropic' :
      loaded.meta.defaultEndpoint === 'custom' || !loaded.meta.defaultEndpoint ? 'openai' :
      loaded.meta.defaultEndpoint;
    const { createKeyManager } = await import('../../key/manager.ts');
    const km = createKeyManager();
    let storedBaseUrl: string | undefined;
    try { storedBaseUrl = await km.getBaseUrl(providerId, loaded.meta.id); } catch { /* no stored url */ }
    const { resolveProviderKey } = await import('../../providers/registry.ts');
    let apiKey: string | undefined;
    try {
      const resolved = await resolveProviderKey({ providerId, wsId: loaded.meta.id });
      apiKey = resolved.apiKey;
    } catch (err) {
      if (!(err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND)) throw err;
    }
    const providerKind: 'anthropic' | 'openai-compat' = loaded.meta.defaultProvider === 'anthropic' ? 'anthropic' : 'openai-compat';
    const cfg: Parameters<typeof createProviderFromConfig>[0] = { kind: providerKind, model: loaded.meta.defaultModel };
    if (apiKey) cfg.apiKey = apiKey;
    if (providerKind === 'openai-compat') {
      const envBase = process.env['OPENAI_BASE_URL'];
      const effectiveBaseUrl = loaded.meta.defaultBaseUrl ?? storedBaseUrl ?? envBase;
      if (loaded.meta.defaultEndpoint === 'custom' || (effectiveBaseUrl && !loaded.meta.defaultEndpoint)) {
        cfg.endpoint = 'custom';
        if (effectiveBaseUrl) cfg.baseUrl = effectiveBaseUrl;
        if (!apiKey) cfg.apiKey = process.env['OPENAI_API_KEY'];
      } else if (loaded.meta.defaultEndpoint) {
        cfg.endpoint = loaded.meta.defaultEndpoint;
        if (effectiveBaseUrl) cfg.baseUrl = effectiveBaseUrl;
      } else {
        cfg.endpoint = 'openai';
      }
    } else {
      const baseUrl = loaded.meta.defaultBaseUrl ?? storedBaseUrl;
      if (baseUrl) cfg.baseUrl = baseUrl;
    }
    providerCache = createProviderFromConfig(cfg);
    return providerCache;
  }

  // Telegram bridge (SPEC-808): must be set before first submit.
  setTelegramRuntimeBridge((_toolCtx) => {
    if (!providerCache) return null;
    return { provider: providerCache, model: loaded.meta.defaultModel, registry, gate, cwd: process.cwd() };
  });

  async function handleSubmit(value: string): Promise<void> {
    let provider: import('../../ir/types.ts').Provider;
    try {
      provider = await getProvider();
    } catch (err) {
      if (err instanceof NimbusError) {
        const formatted = formatBootError({ code: err.code, context: err.context }, 'vi');
        logger.warn({ code: err.code, context: err.context }, 'provider init failed (ink path)');
        // Publish to event bus so ErrorDialog picks it up
        const { getGlobalBus } = await import('../../core/events.ts');
        const { TOPICS } = await import('../../core/eventTypes.ts');
        getGlobalBus().publish(TOPICS.ui.error, {
          type: 'ui.error',
          error: err,
          ts: Date.now(),
        });
        process.stderr.write(`[nimbus] ${formatted.line}\n`);
      } else {
        logger.error({ err: (err as Error).message }, 'provider init failed (ink path)');
      }
      return;
    }

    const { getOrCreateSession, getCachedMessages, appendToCache } = await import('../../core/sessionManager.ts');
    const { runTurn } = await import('../../core/loop.ts');
    const { createTurnAbort } = await import('../../core/cancellation.ts');

    const session = await getOrCreateSession(loaded.meta.id);
    const abort = createTurnAbort();
    const turnCtx: import('../../core/turn.ts').TurnContext = {
      sessionId: session.id,
      wsId: loaded.meta.id,
      channel: 'cli',
      mode,
      abort,
      provider,
      model: loaded.meta.defaultModel,
    };

    const toolAdapter = createLoopAdapter({
      registry,
      permissions: gate,
      workspaceId: loaded.meta.id,
      sessionId: session.id,
      cwd: process.cwd(),
      mode,
      host: inkUIHost && mode !== 'bypass' ? inkUIHost : undefined,
    });

    const priorMessages = getCachedMessages(session.id);
    appendToCache(session.id, { role: 'user', content: [{ type: 'text', text: value }] });

    let assistantTextBuf = '';
    try {
      for await (const out of runTurn({ ctx: turnCtx, userMessage: value, tools: toolAdapter, priorMessages })) {
        if (out.kind === 'chunk' && out.chunk.type === 'content_block_delta' && out.chunk.delta.type === 'text') {
          assistantTextBuf += out.chunk.delta.text ?? '';
        } else if (out.kind === 'chunk' && out.chunk.type === 'content_block_stop') {
          if (assistantTextBuf.length > 0) {
            appendToCache(session.id, { role: 'assistant', content: [{ type: 'text', text: assistantTextBuf }] });
            assistantTextBuf = '';
          }
        }
      }
      if (assistantTextBuf.length > 0) {
        appendToCache(session.id, { role: 'assistant', content: [{ type: 'text', text: assistantTextBuf }] });
      }
    } catch (err) {
      if (err instanceof NimbusError) {
        logger.warn({ code: err.code, context: err.context }, 'repl turn error (ink path)');
        const { getGlobalBus } = await import('../../core/events.ts');
        const { TOPICS } = await import('../../core/eventTypes.ts');
        getGlobalBus().publish(TOPICS.ui.error, { type: 'ui.error', error: err, ts: Date.now() });
      } else {
        logger.error({ err: (err as Error).message }, 'repl turn error (ink path)');
      }
    }
  }

  // Mount Ink app
  const mounted = mountReplApp({
    workspace,
    mode,
    lastBootAt: bootedMeta.lastBootAt,
    numStartups: bootedMeta.numStartups,
    workspaceRoot: process.cwd(),
    onSubmit: (value: string) => { void handleSubmit(value); },
    onExit: () => { mounted.unmount(); },
    onUIHostReady: (host: LoopUIHost) => { inkUIHost = host; },
  });

  // SIGINT / SIGTERM: unmount Ink cleanly + restore terminal (SPEC-851 §2.1)
  const cleanupAndExit = (code: number): void => {
    try { mounted.unmount(); } catch { /* already unmounted */ }
    setTelegramRuntimeBridge(null);
    unwireBus();
    try { getChannelRuntime().dispose().catch(() => { /* ignore */ }); } catch { /* ignore */ }
    process.exit(code);
  };

  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));

  // Await Ink exit (user pressed Ctrl-C twice or called /exit)
  try {
    await mounted.waitUntilExit();
  } finally {
    setTelegramRuntimeBridge(null);
    unwireBus();
    try { await getChannelRuntime().dispose(); } catch { /* best-effort */ }
  }
}
