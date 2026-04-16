// repl.ts — SPEC-801 T4+T5: interactive REPL wired to runTurn + slash dispatcher + SIGINT escalation.
// SPEC-825: onAsk bridge wired to inline y/n/always/never prompt.

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
import { createDefaultRegistry, createLoopAdapter, type ToolRegistry } from '../../tools/index.ts';
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

export interface ReplOptions {
  workspaceId?: string;
  profile?: string;
  skipPermissions?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

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

function promptStr(state: ReplState): string {
  return `${colors.bold(state.wsName)} ${colors.dim('›')} `;
}

function resolveProviderKind(defaultProvider: string): 'anthropic' | 'openai-compat' {
  return defaultProvider === 'anthropic' ? 'anthropic' : 'openai-compat';
}

async function lazyProvider(state: ReplState): Promise<Provider> {
  if (state.provider) return state.provider;

  // SPEC-902 bugfix #5 — baseUrl priority chain:
  //   1. workspace.json defaultBaseUrl (explicit user intent, highest)
  //   2. secret store meta.baseUrl (from `key set --base-url`)
  //   3. OPENAI_BASE_URL env (legacy)
  //   4. endpoint default (api.openai.com)
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
    const resolved = await resolveProviderKey({
      providerId,
      wsId: state.wsId,
    });
    apiKey = resolved.apiKey;
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
      // expected — key just not stored yet; leave apiKey undefined
    } else {
      throw err; // propagate U_MISSING_CONFIG, X_CRED_ACCESS so user sees real error
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
    // anthropic: workspace.json defaultBaseUrl → secret-store meta.baseUrl → SDK default.
    const baseUrl = state.baseUrl ?? storedBaseUrl;
    if (baseUrl) cfg.baseUrl = baseUrl;
  }

  const provider = createProviderFromConfig(cfg);
  state.provider = provider;
  return provider;
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const write = (s: string): void => {
    output.write(s);
  };

  // Fix 1a — auto-provision vault passphrase on REPL boot so vault decrypt works
  // without requiring the user to re-run init. No-op if already provisioned or no
  // workspace yet (runAutoInit will call it on its own path).
  {
    const { autoProvisionPassphrase } = await import('../../platform/secrets/fileFallback.ts');
    try {
      await autoProvisionPassphrase();
    } catch {
      // no-op: workspace may not exist yet (runAutoInit path will call it)
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
  const gate = createGate({
    rules: compileRules([]),
    bypassCliFlag: opts.skipPermissions === true,
  });

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

  // SPEC-823 T4 — persist boot meta, then render welcome screen
  let bootedMeta = loaded.meta;
  try {
    bootedMeta = await persistBootMeta(state.wsId);
  } catch {
    // non-fatal: welcome still renders with defaults
  }
  const welcomeCols = (output as NodeJS.WriteStream).columns ?? 80;
  const welcomeIsTTY = (output as NodeJS.WriteStream).isTTY === true;
  const welcomeNoColor = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '';
  const welcome = renderWelcome({
    wsName: state.wsName,
    model: state.model,
    providerKind: state.providerKind,
    endpoint: state.endpoint,
    lastBootAt: bootedMeta.lastBootAt,
    numStartups: bootedMeta.numStartups,
    cols: welcomeCols,
    isTTY: welcomeIsTTY,
    noColor: welcomeNoColor,
  });
  write(`${welcome}\n`);

  const rl = createInterface({ input, output, terminal: true });

  const ctx = makeReplContext(state, rl, write, input, output);

  rl.on('SIGINT', () => {
    handleSigint(state, rl, write);
  });

  rl.on('close', () => {
    state.running = false;
  });

  const renderer = createRenderer(write);

  // TTY check: use autocomplete dropdown when running interactively.
  const ttyInput = input as AutocompleteInput;
  const isTTY = ttyInput.isTTY === true && typeof ttyInput.setRawMode === 'function' &&
    process.env['TERM'] !== 'dumb';

  const ac = isTTY
    ? createAutocomplete({
        input: ttyInput,
        output,
        promptStr: () => promptStr(state),
        commands: listCommands,
        cols: () => (process.stdout.columns ?? 80),
      })
    : null;

  // SIGWINCH: refresh cols for autocomplete (no-op for non-TTY)
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

    await runSingleTurn(state, trimmed, renderer, write, input, output, isTTY);
  }

  if (isTTY) process.off('SIGWINCH', onSigwinch);
  ac?.dispose();
  unwireBus();
  rl.close();
}

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
      // Force-create new session by resetting cache is not exposed; simplest: create+use.
      const { createSession } = await import('../../storage/sessionStore.ts');
      const meta = await createSession(state.wsId);
      const { setActiveSession } = await import('../../core/sessionManager.ts');
      await setActiveSession(state.wsId, meta);
      write(`${colors.ok(prefixes.ok)} new session ${meta.id}\n`);
    },
    clearScreen: () => {
      // v0.3.3 fix — /clear was routed to LLM as natural text; now a first-class slash command.
      // Standard ANSI: \x1b[2J erases screen, \x1b[3J clears scrollback, \x1b[H homes cursor.
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
      if (all.length === 0) {
        write('no workspaces\n');
        return;
      }
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
      if (!p) {
        write(`provider: ${state.providerKind}\n`);
        return;
      }
      write(`${colors.dim('provider change requires workspace edit; see workspace.json')}\n`);
    },
    setModel: async (m: string) => {
      if (!m) {
        write(`model: ${state.model}\n`);
        return;
      }
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
      } catch {
        apiKey = undefined;
      }
      const pickerInput = input as NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
      const selected = await handleModelPicker({
        workspace: meta,
        apiKey,
        output,
        input: pickerInput,
      });
      if (selected) {
        state.model = selected;
        state.provider = null;
        write(`${colors.ok(prefixes.ok)} model set to ${selected} (saved to workspace)\n`);
      }
    },
    showCost: async () => {
      // SPEC-701: route to cost aggregator for active workspace (default window=today).
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
      // SPEC-132: spec-confirm mode removed (taskSpec superseded by TodoWriteTool)
    },
  };
}

/** SPEC-825 T3: human-readable description of what the tool will do.
 *  SPEC-826 will expand this properly; this is the v0.3.2 inline subset. */
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

/** SPEC-825 T3: parse y/n/always/never from raw answer string.
 *  Exported for tests. */
export function parseConfirmAnswer(raw: string): 'allow' | 'deny' | 'always' | null {
  const v = raw.trim().toLowerCase();
  if (v === 'y' || v === 'yes' || v === '') return 'allow';
  if (v === 'n' || v === 'no') return 'deny';
  if (v === 'always' || v === 'a') return 'always';
  if (v === 'never') return 'deny';
  return null;
}

/** SPEC-825 T3: build the onAsk callback for the loop adapter.
 *  Streams the question to output and reads one line from input.
 *  Falls back to 'deny' on timeout (10s) or non-interactive TTY.
 *
 *  v0.3.5 URGENT FIX: prior impl used node:readline createInterface to read
 *  the y/n answer. On rl.close() Node/Bun explicitly PAUSES stdin (see
 *  lib/internal/readline/interface.js — close() emits 'pause'). When control
 *  returned to the outer slashAutocomplete readLine() which calls
 *  setRawMode(true) + on('data', ...), stdin stays paused (attaching a data
 *  listener does not auto-resume an explicitly paused stream in Bun 1.3). With
 *  no pending I/O keeping the loop alive, Bun exits with code 0 mid-REPL —
 *  user sees the shell prompt return.
 *
 *  Fix: read the single y/n/always/never token directly via raw-mode 'data'
 *  event — identical mechanism to slashAutocomplete. No createInterface, no
 *  pause on stdin, REPL stays alive on the next readLine() cycle. */
export function makeOnAsk(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  isTTY: boolean,
): ((inv: LoopToolInvocation) => Promise<'allow' | 'deny' | 'always'>) | undefined {
  if (!isTTY) return undefined;
  const rawInput = input as NodeJS.ReadableStream & {
    setRawMode?: (b: boolean) => unknown;
    setEncoding?: (enc: BufferEncoding) => unknown;
    isTTY?: boolean;
  };
  return async (inv: LoopToolInvocation): Promise<'allow' | 'deny' | 'always'> => {
    const humanAction = humanizeToolInvocation(inv);
    const question = `${colors.warn(prefixes.ask)} Cho em ${humanAction}? [Y/n/always/never] `;
    output.write(question);
    return new Promise<'allow' | 'deny' | 'always'>((resolve) => {
      let settled = false;
      let buffer = '';
      const prevRaw = rawInput.isTTY === true;

      const cleanup = (): void => {
        rawInput.removeListener('data', onData);
        // Restore line-mode so subsequent listeners (autocomplete) see the
        // stream in a known baseline. setRawMode(false) is safe even if we
        // never turned it on.
        if (typeof rawInput.setRawMode === 'function' && prevRaw) {
          try { rawInput.setRawMode(false); } catch { /* ignore */ }
        }
      };

      const finish = (dec: 'allow' | 'deny' | 'always'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(dec);
      };

      const onData = (chunk: Buffer | string): void => {
        if (settled) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Ctrl-C (0x03) during confirm → deny (same as outer REPL treats it).
        if (text.includes('\x03')) {
          output.write('\n');
          finish('deny');
          return;
        }
        // Echo printable chars so user sees what they typed (raw mode disables
        // terminal echo). Skip backspace handling — a single-token confirm is
        // simple enough that typos just collect until Enter; `parseConfirmAnswer`
        // lowercases + trims anyway.
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') {
            output.write('\n');
            const answer = parseConfirmAnswer(buffer);
            finish(answer === 'always' ? 'always' : answer === 'allow' ? 'allow' : 'deny');
            return;
          }
          // Backspace / DEL
          if (ch === '\x7f' || ch === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              output.write('\b \b');
            }
            continue;
          }
          buffer += ch;
          output.write(ch);
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        output.write(`\n${colors.dim('(timeout — default: No)')}\n`);
        finish('deny');
      }, 10_000);

      if (typeof rawInput.setEncoding === 'function') rawInput.setEncoding('utf8');
      if (typeof rawInput.setRawMode === 'function') {
        try { rawInput.setRawMode(true); } catch { /* ignore */ }
      }
      rawInput.on('data', onData);
      // Defense: ensure stream is flowing even if a prior close() paused it.
      (rawInput as { resume?: () => void }).resume?.();
    });
  };
}

async function runSingleTurn(
  state: ReplState,
  userMessage: string,
  renderer: ReturnType<typeof createRenderer>,
  write: (s: string) => void,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  isTTY: boolean,
): Promise<void> {
  const session = await getOrCreateSession(state.wsId);
  const abort = createTurnAbort();
  state.turnAbort = abort;
  let provider: Provider;
  try {
    provider = await lazyProvider(state);
  } catch (err) {
    if (err instanceof NimbusError) {
      write(`${colors.err(prefixes.err)} ${err.code}: ${JSON.stringify(err.context)}\n`);
      if (err.context['reason'] === 'ANTHROPIC_API_KEY missing') {
        write(`${colors.dim('hint: export ANTHROPIC_API_KEY=... before starting nimbus.')}\n`);
      }
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
  // SPEC-825: wire onAsk for interactive TTY (skipped in bypass mode — no prompts needed).
  const onAsk = state.mode !== 'bypass'
    ? makeOnAsk(input, output, isTTY)
    : undefined;
  const toolAdapter = createLoopAdapter({
    registry: state.registry,
    permissions: state.gate,
    workspaceId: state.wsId,
    sessionId: session.id,
    cwd: process.cwd(),
    mode: state.mode,
    onAsk,
  });
  // SPEC-121: snapshot prior messages before the turn for rehydration
  const priorMessages = getCachedMessages(session.id);

  // Append user message to cache now (loop.ts persists to JSONL separately)
  const userMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: userMessage }] };
  appendToCache(session.id, userMsg);

  let assistantTextBuf = '';
  try {
    for await (const out of runTurn({
      ctx: turnCtx,
      userMessage,
      tools: toolAdapter,
      priorMessages,
    })) {
      renderer.handle(out);
      // Collect assistant text from streaming chunks for cache
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
