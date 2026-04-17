// repl.legacy.ts — SPEC-851: Legacy readline REPL path (NIMBUS_UI=legacy).
// Extracted from repl.ts v0.3.x. Deprecated in v0.4.0 — scheduled for deletion in v0.4.1.
// @deprecated Use Ink path (default). Set NIMBUS_UI=legacy to invoke this path.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { getActiveWorkspace, switchWorkspace, listAllWorkspaces } from '../../core/workspace.ts';
import { loadWorkspace } from '../../storage/workspaceStore.ts';
import { getOrCreateSession, getCachedMessages, appendToCache } from '../../core/sessionManager.ts';
import { runTurn } from '../../core/loop.ts';
import { createTurnAbort, CANCEL_ESCALATION_WINDOW_MS } from '../../core/cancellation.ts';
import { createProviderFromConfig } from '../../providers/registry.ts';
import type { Provider } from '../../ir/types.ts';
import type { TurnContext } from '../../core/turn.ts';
import type { ToolInvocation as LoopToolInvocation } from '../../core/loop.ts';
// eslint-disable-next-line import/no-restricted-paths -- legacy composition root; tool registry injected here
import { createDefaultRegistry, createLoopAdapter, type ToolRegistry } from '../../tools/index.ts';
import { createCliUIHost } from './ui/cliHost.ts';
import { createGate, compileRules, type Gate } from '../../permissions/index.ts';
import { colors, prefixes } from './colors.ts';
import { renderWelcome } from './welcome.ts';
import { persistBootMeta } from '../../core/workspace.ts';
import { createRenderer } from './render.ts';
import {
  dispatchSlash,
  listCommands,
  parseSlash,
  registerDefaultCommands,
  __resetRegistry,
} from './slashCommands.ts';
import { createAutocomplete, type AutocompleteInput } from './slashAutocomplete.ts';
import { handleModelPicker } from './modelPicker.ts';
import { wireBusSubscribers } from './subscriptions.ts';
// eslint-disable-next-line import/no-restricted-paths -- legacy path wires Telegram bridge directly
import { setTelegramRuntimeBridge } from '../../tools/builtin/Telegram.ts';
import { getChannelRuntime } from '../runtime.ts';
import { formatBootError } from './errorFormatCli.ts';
import type { ReplOptions } from './repl.ts';

// ── Internal state type ────────────────────────────────────────────────────────

interface ReplState {
  wsId: string;
  wsName: string;
  provider: Provider | null;
  model: string;
  providerKind: 'anthropic' | 'openai-compat';
  endpoint: 'openai' | 'groq' | 'deepseek' | 'ollama' | 'gemini' | 'custom' | undefined;
  baseUrl: string | undefined;
  mode: 'readonly' | 'default' | 'acceptEdits' | 'bypass';
  running: boolean;
  turnAbort: ReturnType<typeof createTurnAbort> | null;
  lastCtrlCAt: number;
  ctrlCCount: number;
  registry: ToolRegistry;
  gate: Gate;
  skipPermissions: boolean;
}

// ── Helper: prompt string ──────────────────────────────────────────────────────

function promptStr(state: ReplState): string {
  return `${colors.bold(state.wsName)} ${colors.dim('›')} `;
}

// ── Helper: resolve provider kind ─────────────────────────────────────────────

function resolveProviderKind(defaultProvider: string): 'anthropic' | 'openai-compat' {
  return defaultProvider === 'anthropic' ? 'anthropic' : 'openai-compat';
}

// ── lazyProvider ───────────────────────────────────────────────────────────────

async function lazyProvider(state: ReplState): Promise<Provider> {
  if (state.provider) return state.provider;

  const providerId = state.providerKind === 'anthropic' ? 'anthropic' : state.endpoint === 'custom' || state.endpoint === undefined ? 'openai' : state.endpoint;
  const { createKeyManager } = await import('../../key/manager.ts');
  const km = createKeyManager();
  let storedBaseUrl: string | undefined;
  try {
    storedBaseUrl = await km.getBaseUrl(providerId, state.wsId);
  } catch {
    storedBaseUrl = undefined;
  }

  const { resolveProviderKey } = await import('../../providers/registry.ts');
  let apiKey: string | undefined;
  try {
    const resolved = await resolveProviderKey({ providerId, wsId: state.wsId });
    apiKey = resolved.apiKey;
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
      // expected — key not stored yet
    } else {
      throw err;
    }
  }

  const cfg: Parameters<typeof createProviderFromConfig>[0] = {
    kind: state.providerKind,
    model: state.model,
  };
  if (apiKey) cfg.apiKey = apiKey;

  if (state.providerKind === 'openai-compat') {
    const envBase = process.env['OPENAI_BASE_URL'];
    const effectiveBaseUrl = state.baseUrl ?? storedBaseUrl ?? envBase;
    if (state.endpoint === 'custom' || (effectiveBaseUrl && !state.endpoint)) {
      cfg.endpoint = 'custom';
      if (effectiveBaseUrl) cfg.baseUrl = effectiveBaseUrl;
      if (!apiKey) cfg.apiKey = process.env['OPENAI_API_KEY'];
    } else if (state.endpoint) {
      cfg.endpoint = state.endpoint;
      if (effectiveBaseUrl) cfg.baseUrl = effectiveBaseUrl;
    } else {
      cfg.endpoint = 'openai';
    }
  } else if (state.providerKind === 'anthropic') {
    const baseUrl = state.baseUrl ?? storedBaseUrl;
    if (baseUrl) cfg.baseUrl = baseUrl;
  }

  const provider = createProviderFromConfig(cfg);
  state.provider = provider;
  return provider;
}

// ── SIGINT handler ─────────────────────────────────────────────────────────────

function handleSigint(state: ReplState, rl: ReadlineInterface, write: (s: string) => void): void {
  const now = Date.now();
  if (now - state.lastCtrlCAt > CANCEL_ESCALATION_WINDOW_MS) state.ctrlCCount = 0;
  state.ctrlCCount += 1;
  state.lastCtrlCAt = now;
  if (state.turnAbort && state.ctrlCCount === 1) {
    state.turnAbort.turn.abort(new Error('sigint_user'));
    write(`\n${colors.warn(prefixes.warn)} cancelling turn...\n`);
    return;
  }
  if (state.ctrlCCount >= 2) {
    write(`\n${colors.dim('bye.')}\n`);
    state.running = false;
    rl.close();
  } else {
    write(`\n${colors.dim('(press Ctrl-C again to exit)')}\n`);
    rl.prompt();
  }
}

// ── readLine ──────────────────────────────────────────────────────────────────

function readLine(rl: ReadlineInterface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      rl.off('line', onLine);
      rl.off('close', onClose);
      resolve(v);
    };
    const onLine = (line: string): void => finish(line);
    const onClose = (): void => finish(null);
    rl.once('line', onLine);
    rl.once('close', onClose);
    rl.setPrompt(prompt);
    rl.prompt();
  });
}

// ── makeReplContext ────────────────────────────────────────────────────────────

function makeReplContext(
  state: ReplState,
  rl: ReadlineInterface,
  write: (s: string) => void,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): import('./slashCommands.ts').ReplContext {
  return {
    wsId: state.wsId,
    write: (line: string) => write(line.endsWith('\n') ? line : `${line}\n`),
    setMode: (m) => {
      if (m === 'bypass' && !state.skipPermissions) {
        write(`${colors.err(prefixes.err)} bypass requires --dangerously-skip-permissions at startup\n`);
        return;
      }
      state.mode = m;
      write(`${colors.dim(`mode: ${m}`)}\n`);
    },
    currentMode: () => state.mode,
    cancelTurn: () => {
      if (state.turnAbort) state.turnAbort.turn.abort(new Error('user_stop'));
    },
    quit: () => {
      state.running = false;
      rl.close();
    },
    newSession: async () => {
      const { createSession } = await import('../../storage/sessionStore.ts');
      const meta = await createSession(state.wsId);
      const { setActiveSession } = await import('../../core/sessionManager.ts');
      await setActiveSession(state.wsId, meta);
      write(`${colors.ok(prefixes.ok)} new session ${meta.id}\n`);
    },
    clearScreen: () => {
      const isTerminal = (output as NodeJS.WriteStream).isTTY === true;
      if (isTerminal) write('\x1b[2J\x1b[3J\x1b[H');
    },
    switchWorkspace: async (name: string) => {
      const all = await listAllWorkspaces();
      const target = all.find((w) => w.name === name || w.id === name);
      if (!target) {
        write(`${colors.err(prefixes.err)} workspace not found: ${name}\n`);
        return;
      }
      await switchWorkspace(target.id);
      state.wsId = target.id;
      state.wsName = target.name;
      state.model = target.defaultModel;
      state.providerKind = resolveProviderKind(target.defaultProvider);
      state.endpoint = target.defaultEndpoint;
      state.baseUrl = target.defaultBaseUrl;
      state.provider = null;
      write(`${colors.ok(prefixes.ok)} switched to ${target.name}\n`);
    },
    listWorkspaces: async () => {
      const all = await listAllWorkspaces();
      if (all.length === 0) { write('no workspaces\n'); return; }
      for (const w of all) {
        const active = w.id === state.wsId ? colors.ok('*') : ' ';
        write(`${active} ${w.name.padEnd(20)} ${colors.dim(w.defaultModel)}\n`);
      }
    },
    showSoul: async () => {
      const { paths } = await loadWorkspace(state.wsId);
      const f = Bun.file(paths.soulMd);
      if (await f.exists()) write(`${await f.text()}\n`);
      else write('SOUL.md not found\n');
    },
    showMemory: async () => {
      const { paths } = await loadWorkspace(state.wsId);
      const f = Bun.file(paths.memoryMd);
      if (await f.exists()) write(`${await f.text()}\n`);
      else write('MEMORY.md not found\n');
    },
    showIdentity: async () => {
      const { paths } = await loadWorkspace(state.wsId);
      const f = Bun.file(paths.identityMd);
      if (await f.exists()) write(`${await f.text()}\n`);
      else write('IDENTITY.md not found\n');
    },
    setProvider: async (p: string) => {
      if (!p) { write(`provider: ${state.providerKind}\n`); return; }
      write(`${colors.dim('provider change requires workspace edit; see workspace.json')}\n`);
    },
    setModel: async (m: string) => {
      if (!m) { write(`model: ${state.model}\n`); return; }
      state.model = m;
      state.provider = null;
      write(`${colors.ok(prefixes.ok)} model now ${m} (session-only)\n`);
    },
    pickModel: async () => {
      const { meta } = await loadWorkspace(state.wsId);
      const providerId = state.providerKind === 'anthropic' ? 'anthropic' : state.endpoint ?? 'openai';
      let apiKey: string | undefined;
      try {
        const { resolveProviderKey } = await import('../../providers/registry.ts');
        const resolved = await resolveProviderKey({ providerId, wsId: state.wsId });
        apiKey = resolved.apiKey;
      } catch { apiKey = undefined; }
      const pickerInput = input as NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
      const selected = await handleModelPicker({ workspace: meta, apiKey, output, input: pickerInput });
      if (selected) {
        state.model = selected;
        state.provider = null;
        write(`${colors.ok(prefixes.ok)} model set to ${selected} (saved to workspace)\n`);
      }
    },
    showCost: async () => {
      try {
        const { aggregate } = await import('../../cost/aggregator.ts');
        const { renderRollup } = await import('../../cost/dashboard.ts');
        const rollup = await aggregate(state.wsId, 'today');
        write(`${renderRollup(rollup, { window: 'today', by: 'provider' })}\n`);
      } catch (err) {
        write(`${colors.err(prefixes.err)} cost: ${(err as Error).message}\n`);
      }
    },
    setSpecConfirm: (_mode) => {
      // SPEC-132: spec-confirm mode removed
    },
  };
}

// ── humanizeToolInvocation ─────────────────────────────────────────────────────

function humanizeToolInvocation(inv: LoopToolInvocation): string {
  const input = (inv.input ?? {}) as Record<string, unknown>;
  const path = typeof input['path'] === 'string' ? input['path'] : undefined;
  const filePath = typeof input['filePath'] === 'string' ? input['filePath'] : path;
  switch (inv.name) {
    case 'Write': return `ghi file ${filePath ?? '?'}`;
    case 'Edit': return `sửa ${filePath ?? '?'}`;
    case 'MultiEdit': return `sửa nhiều ${filePath ?? '?'}`;
    case 'Bash': {
      const cmd = typeof input['cmd'] === 'string' ? input['cmd'] : typeof input['command'] === 'string' ? input['command'] : '?';
      return `chạy lệnh: ${cmd.slice(0, 60)}`;
    }
    case 'NotebookEdit': return `sửa notebook ${filePath ?? '?'}`;
    default: return inv.name;
  }
}

// ── makeOnAsk (legacy) ────────────────────────────────────────────────────────
// @deprecated Will be removed in v0.4.1. Use Ink UIHost instead.

export function makeOnAsk(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  isTTY: boolean,
): ((inv: LoopToolInvocation) => Promise<'allow' | 'deny' | 'always'>) | undefined {
  if (!isTTY) return undefined;
  return async (inv: LoopToolInvocation): Promise<'allow' | 'deny' | 'always'> => {
    const humanAction = humanizeToolInvocation(inv);
    const question = `${colors.warn(prefixes.ask)} Cho em ${humanAction}?`;
    const { confirmPick } = await import('../../onboard/picker.ts');
    const decision = await confirmPick(question, {
      input: input as NodeJS.ReadableStream & { setRawMode?: (b: boolean) => unknown; isTTY?: boolean },
      output,
    });
    if (decision === 'never') return 'deny';
    return decision;
  };
}

// ── parseConfirmAnswer (kept for tests) ───────────────────────────────────────

export function parseConfirmAnswer(raw: string): 'allow' | 'deny' | 'always' | null {
  const v = raw.trim().toLowerCase();
  if (v === 'y' || v === 'yes' || v === '') return 'allow';
  if (v === 'n' || v === 'no') return 'deny';
  if (v === 'always' || v === 'a') return 'always';
  if (v === 'never') return 'deny';
  return null;
}

// ── runSingleTurn ─────────────────────────────────────────────────────────────

async function runSingleTurn(
  state: ReplState,
  userMessage: string,
  renderer: ReturnType<typeof createRenderer>,
  write: (s: string) => void,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  isTTY: boolean,
  host?: ReturnType<typeof createCliUIHost>,
): Promise<void> {
  const session = await getOrCreateSession(state.wsId);
  const abort = createTurnAbort();
  state.turnAbort = abort;
  let provider: Provider;
  try {
    provider = await lazyProvider(state);
  } catch (err) {
    if (err instanceof NimbusError) {
      const formatted = formatBootError({ code: err.code, context: err.context }, 'vi');
      write(`${colors.err(prefixes.err)} ${formatted.line}\n`);
      if (formatted.hint) write(`${colors.dim(`  → ${formatted.hint}`)}\n`);
      logger.warn({ code: err.code, context: err.context }, 'provider init failed');
    } else {
      write(`${colors.err(prefixes.err)} ${(err as Error).message}\n`);
    }
    state.turnAbort = null;
    return;
  }
  const turnCtx: TurnContext = {
    sessionId: session.id,
    wsId: state.wsId,
    channel: 'cli',
    mode: state.mode,
    abort,
    provider,
    model: state.model,
  };
  const onAsk = state.mode !== 'bypass' ? makeOnAsk(input, output, isTTY) : undefined;
  const toolAdapter = createLoopAdapter({
    registry: state.registry,
    permissions: state.gate,
    workspaceId: state.wsId,
    sessionId: session.id,
    cwd: process.cwd(),
    mode: state.mode,
    onAsk,
    host: host && state.mode !== 'bypass' ? host : undefined,
  });
  const priorMessages = getCachedMessages(session.id);
  const userMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: userMessage }] };
  appendToCache(session.id, userMsg);

  let assistantTextBuf = '';
  try {
    for await (const out of runTurn({ ctx: turnCtx, userMessage, tools: toolAdapter, priorMessages })) {
      renderer.handle(out);
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
    renderer.flush();
    if (err instanceof NimbusError) {
      write(`${colors.err(prefixes.err)} ${err.code}: ${JSON.stringify(err.context)}\n`);
    } else {
      logger.error({ err: (err as Error).message }, 'repl turn error');
      write(`${colors.err(prefixes.err)} ${(err as Error).message}\n`);
    }
  } finally {
    state.turnAbort = null;
    renderer.flush();
  }
}

// ── startReplLegacy — public entry point ───────────────────────────────────────

/**
 * @deprecated Legacy readline REPL path. Will be removed in v0.4.1.
 * Invoked when NIMBUS_UI=legacy environment variable is set.
 */
export async function startReplLegacy(opts: ReplOptions = {}): Promise<void> {
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const write = (s: string): void => { output.write(s); };

  // Deprecation notice
  process.stderr.write(
    '[nimbus] DEPRECATION: NIMBUS_UI=legacy uses the old readline REPL. ' +
    'This path will be removed in v0.4.1. Unset NIMBUS_UI to use the Ink UI.\n',
  );

  {
    const { autoProvisionPassphrase } = await import('../../platform/secrets/fileFallback.ts');
    try {
      await autoProvisionPassphrase();
    } catch (err) {
      if (err instanceof NimbusError && err.code === ErrorCode.X_CRED_ACCESS) {
        const formatted = formatBootError({ code: err.code, context: err.context }, 'vi');
        write(`${colors.warn(prefixes.warn)} ${formatted.line}\n`);
        if (formatted.hint) write(`${colors.dim(`  → ${formatted.hint}`)}\n`);
      }
    }
  }

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
  const kind = resolveProviderKind(loaded.meta.defaultProvider);

  const registry = createDefaultRegistry({ includeBash: true, includeMemory: true });
  const gate = createGate({ rules: compileRules([]), bypassCliFlag: opts.skipPermissions === true });

  const state: ReplState = {
    wsId: loaded.meta.id,
    wsName: loaded.meta.name,
    provider: null,
    providerKind: kind,
    endpoint: loaded.meta.defaultEndpoint,
    baseUrl: loaded.meta.defaultBaseUrl,
    model: loaded.meta.defaultModel,
    mode: 'default',
    running: true,
    turnAbort: null,
    lastCtrlCAt: 0,
    ctrlCCount: 0,
    registry,
    gate,
    skipPermissions: opts.skipPermissions === true,
  };

  if (opts.skipPermissions) {
    if (process.env['NIMBUS_BYPASS_CONFIRMED'] !== '1') {
      write(`${colors.err(prefixes.err)} --dangerously-skip-permissions requires NIMBUS_BYPASS_CONFIRMED=1\n`);
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'bypass_not_confirmed' });
    }
    state.mode = 'bypass';
    write(`${colors.warn(prefixes.warn)} permissions bypass enabled — destructive actions will NOT prompt\n`);
  }

  __resetRegistry();
  registerDefaultCommands();

  const unwireBus = wireBusSubscribers({ workspaceId: state.wsId, channel: 'cli' });

  getChannelRuntime();

  setTelegramRuntimeBridge((_toolCtx) => {
    if (!state.provider) return null;
    return { provider: state.provider, model: state.model, registry: state.registry, gate: state.gate, cwd: process.cwd() };
  });

  let bootedMeta = loaded.meta;
  try { bootedMeta = await persistBootMeta(state.wsId); } catch { /* non-fatal */ }

  const welcomeCols = (output as NodeJS.WriteStream).columns ?? 80;
  const welcomeIsTTY = (output as NodeJS.WriteStream).isTTY === true;
  const welcomeNoColor = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '';
  const welcome = renderWelcome({
    wsName: state.wsName, model: state.model, providerKind: state.providerKind,
    endpoint: state.endpoint, lastBootAt: bootedMeta.lastBootAt,
    numStartups: bootedMeta.numStartups, cols: welcomeCols,
    isTTY: welcomeIsTTY, noColor: welcomeNoColor,
  });
  write(`${welcome}\n`);

  const rl = createInterface({ input, output, terminal: true });
  const ctx = makeReplContext(state, rl, write, input, output);

  rl.on('SIGINT', () => { handleSigint(state, rl, write); });
  rl.on('close', () => { state.running = false; });

  const renderer = createRenderer(write);
  const ttyInput = input as AutocompleteInput;
  const isTTY = ttyInput.isTTY === true && typeof ttyInput.setRawMode === 'function' &&
    process.env['TERM'] !== 'dumb';

  const colorEnabled = process.env['NO_COLOR'] === undefined || process.env['NO_COLOR'] === '';
  const cliUIHost = createCliUIHost({
    stdin: ttyInput as NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean },
    stdout: output as NodeJS.WriteStream,
    isTTY,
    colorEnabled,
  });

  const ac = isTTY
    ? createAutocomplete({
        input: ttyInput, output, promptStr: () => promptStr(state),
        commands: listCommands, cols: () => (process.stdout.columns ?? 80),
      })
    : null;

  const onSigwinch = (): void => { /* cols() re-reads process.stdout.columns live */ };
  if (isTTY) process.on('SIGWINCH', onSigwinch);

  while (state.running) {
    let line: string | null;
    if (ac) {
      line = await ac.readLine();
    } else {
      line = await readLine(rl, promptStr(state));
    }
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (parseSlash(trimmed)) {
      await dispatchSlash(trimmed, ctx);
      if (!state.running) break;
      continue;
    }

    await runSingleTurn(state, trimmed, renderer, write, input, output, isTTY, cliUIHost);
  }

  if (isTTY) process.off('SIGWINCH', onSigwinch);
  ac?.dispose();
  unwireBus();
  try { await getChannelRuntime().dispose(); } catch { /* best-effort */ }
  setTelegramRuntimeBridge(null);
  rl.close();
}
