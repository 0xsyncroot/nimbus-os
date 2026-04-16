// repl.ts — SPEC-801 T4+T5: interactive REPL wired to runTurn + slash dispatcher + SIGINT escalation.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { getActiveWorkspace, switchWorkspace, listAllWorkspaces } from '../../core/workspace.ts';
import { loadWorkspace } from '../../storage/workspaceStore.ts';
import { getOrCreateSession } from '../../core/sessionManager.ts';
import { runTurn } from '../../core/loop.ts';
import { createTurnAbort, CANCEL_ESCALATION_WINDOW_MS } from '../../core/cancellation.ts';
import { createProviderFromConfig } from '../../providers/registry.ts';
import type { Provider } from '../../ir/types.ts';
import type { TurnContext } from '../../core/turn.ts';
import { createDefaultRegistry, createLoopAdapter, type ToolRegistry } from '../../tools/index.ts';
import { createGate, compileRules, type Gate } from '../../permissions/index.ts';
import { colors, prefixes } from './colors.ts';
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
  endpoint: 'openai' | 'groq' | 'deepseek' | 'ollama' | 'custom' | undefined;
  baseUrl: string | undefined;
  mode: 'readonly' | 'default' | 'bypass';
  specConfirmAlways: boolean;
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
    specConfirmAlways: false,
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

  write(`${colors.ok(prefixes.ok)} nimbus ready — workspace "${state.wsName}" (${state.model})\n`);
  write(`${colors.dim('Type /help for commands, Ctrl-C twice to exit.')}\n`);

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

    await runSingleTurn(state, trimmed, renderer, write);
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
      write(`${colors.dim('cost tracking arrives in v0.2')}\n`);
    },
    setSpecConfirm: (mode) => {
      state.specConfirmAlways = mode === 'always';
    },
  };
}

async function runSingleTurn(
  state: ReplState,
  userMessage: string,
  renderer: ReturnType<typeof createRenderer>,
  write: (s: string) => void,
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
  const toolAdapter = createLoopAdapter({
    registry: state.registry,
    permissions: state.gate,
    workspaceId: state.wsId,
    sessionId: session.id,
    cwd: process.cwd(),
    mode: state.mode,
  });
  try {
    for await (const output of runTurn({
      ctx: turnCtx,
      userMessage,
      tools: toolAdapter,
      specConfirmAlways: state.specConfirmAlways,
    })) {
      renderer.handle(output);
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
