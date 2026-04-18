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

  // v0.4.0.2: unified derivation — match getProvider() logic below so pre-flight
  // queries the same providerId that runtime actually uses (fixes namespace split
  // where workspace.json had defaultProvider='openai-compat' kind but vault stored
  // under concrete 'openai' endpoint).
  const resolvedProviderId: string =
    loaded.meta.defaultProvider === 'anthropic' ? 'anthropic' :
    loaded.meta.defaultEndpoint === 'custom' || !loaded.meta.defaultEndpoint ? 'openai' :
    loaded.meta.defaultEndpoint;

  // ── Pre-flight key hint (Bug 5) ───────────────────────────────────────────
  // If resolved provider has no key, show a friendly single-line hint.
  let preflightKeyHint: string | undefined;
  try {
    const { resolveProviderKey } = await import('../../providers/registry.ts');
    await resolveProviderKey({ providerId: resolvedProviderId, wsId: loaded.meta.id });
  } catch {
    preflightKeyHint = `No API key set for "${resolvedProviderId}". Run \`/key set\` to add one.`;
  }

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
    const providerId = resolvedProviderId;
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
        logger.warn({ code: err.code, context: err.context }, 'provider init failed (ink path)');
        // Publish to event bus so ErrorDialog picks it up; no stderr write (Bug 1 fix: prevents Ink frame anchor scroll)
        const { getGlobalBus } = await import('../../core/events.ts');
        const { TOPICS } = await import('../../core/eventTypes.ts');
        getGlobalBus().publish(TOPICS.ui.error, {
          type: 'ui.error',
          error: err,
          ts: Date.now(),
        });
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

    // v0.4.0.2 P0 fix: publish UI stream events so <AssistantMessage> renders output.
    const { getGlobalBus } = await import('../../core/events.ts');
    const { TOPICS } = await import('../../core/eventTypes.ts');
    const bus = getGlobalBus();
    const turnId = session.id + ':' + Date.now().toString(36);
    bus.publish(TOPICS.ui.turnStart, { type: 'ui.turnStart', turnId, ts: Date.now() });

    let assistantTextBuf = '';
    let blockId = turnId + ':0';
    let blockIdx = 0;
    try {
      for await (const out of runTurn({ ctx: turnCtx, userMessage: value, tools: toolAdapter, priorMessages })) {
        if (out.kind === 'chunk' && out.chunk.type === 'content_block_delta' && out.chunk.delta.type === 'text') {
          const text = out.chunk.delta.text ?? '';
          assistantTextBuf += text;
          if (text.length > 0) {
            bus.publish(TOPICS.ui.assistantDelta, { type: 'ui.assistantDelta', turnId, blockId, text, ts: Date.now() });
          }
        } else if (out.kind === 'chunk' && out.chunk.type === 'content_block_stop') {
          if (assistantTextBuf.length > 0) {
            bus.publish(TOPICS.ui.assistantComplete, { type: 'ui.assistantComplete', turnId, blockId, text: assistantTextBuf, ts: Date.now() });
            appendToCache(session.id, { role: 'assistant', content: [{ type: 'text', text: assistantTextBuf }] });
            assistantTextBuf = '';
            blockIdx += 1;
            blockId = turnId + ':' + blockIdx.toString();
          }
        }
      }
      if (assistantTextBuf.length > 0) {
        bus.publish(TOPICS.ui.assistantComplete, { type: 'ui.assistantComplete', turnId, blockId, text: assistantTextBuf, ts: Date.now() });
        appendToCache(session.id, { role: 'assistant', content: [{ type: 'text', text: assistantTextBuf }] });
      }
      bus.publish(TOPICS.ui.turnComplete, { type: 'ui.turnComplete', turnId, outcome: 'success', ts: Date.now() });
    } catch (err) {
      if (err instanceof NimbusError) {
        logger.warn({ code: err.code, context: err.context }, 'repl turn error (ink path)');
        bus.publish(TOPICS.ui.error, { type: 'ui.error', error: err, ts: Date.now() });
        bus.publish(TOPICS.ui.turnComplete, { type: 'ui.turnComplete', turnId, outcome: 'error', errorCode: err.code, ts: Date.now() });
      } else {
        logger.error({ err: (err as Error).message }, 'repl turn error (ink path)');
        bus.publish(TOPICS.ui.turnComplete, { type: 'ui.turnComplete', turnId, outcome: 'error', ts: Date.now() });
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
    keyHint: preflightKeyHint,
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
