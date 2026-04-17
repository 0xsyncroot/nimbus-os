// init.ts — SPEC-901 T4/T5: orchestrate init wizard → workspace + 6 files + .dreams/.
// v0.2.1: 3-prompt fast path (provider picker + key + language); --advanced flag for full wizard.

import { join, isAbsolute, normalize } from 'node:path';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { detect } from '../platform/detect.ts';
import {
  createWorkspaceDir,
  loadWorkspace,
  fileExists,
  updateWorkspace,
} from '../storage/workspaceStore.ts';
import { switchWorkspace } from '../core/workspace.ts';
import { askAll, InitAnswersSchema, type InitAnswers } from './questions.ts';
import { renderTemplates, DEFAULT_SOUL_MD } from './templates.ts';
import { promptApiKey } from './keyPrompt.ts';
import { promptMaskedKey } from '../platform/keyPromptCore.ts';
import { validateKeyFormat, detectProviderFromKey } from './keyValidators.ts';
import { createKeyManager, type KeyManager } from '../key/manager.ts';
import { discoverModels, type DiscoverProvider } from '../catalog/discover.ts';
import { pickModel } from '../catalog/picker.ts';
import { pickOne } from './picker.ts';
import { autoProvisionPassphrase } from '../platform/secrets/fileFallback.ts';

export interface InitRunOpts {
  force?: boolean;
  noPrompt?: boolean;
  advanced?: boolean;
  location?: string;
  answers?: Partial<InitAnswers>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  skipKeyStep?: boolean;
  skipModelPicker?: boolean;
  keyManager?: KeyManager;
  apiKey?: string;
}

/** Provider env var map — used to detect key in env during fast init. */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * askFast — reduced 3-prompt init used by default (no --advanced flag).
 * Q1: provider picker (6 items)
 * Q2: API key (env auto-detect with override)
 * Q3: language picker (2 items, skippable)
 * All other fields → auto-defaults.
 */
async function askFast(io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<{ answers: InitAnswers; envKey?: string }> {
  const output = io.output ?? process.stdout;
  const input = io.input ?? process.stdin;

  // Q1: provider picker
  const providerItems = [
    { value: 'anthropic' as const, label: 'Anthropic (Claude)', hint: 'claude-sonnet-4-6' },
    { value: 'openai' as const, label: 'OpenAI', hint: 'gpt-5.4-mini / gpt-4o' },
    { value: 'groq' as const, label: 'Groq', hint: 'llama-3.3-70b (fast + free tier)' },
    { value: 'deepseek' as const, label: 'DeepSeek', hint: 'deepseek-chat (cost-effective)' },
    { value: 'gemini' as const, label: 'Gemini (AI Studio free tier, 2.5-flash default)', hint: 'gemini-2.5-flash' },
    { value: 'ollama' as const, label: 'Ollama (local)', hint: 'no API key needed' },
    { value: 'custom' as const, label: 'Custom / vLLM / LiteLLM', hint: 'enter base URL' },
  ];

  const providerResult = await pickOne('Choose your AI provider', providerItems, { default: 0 }, { input, output });
  let provider: InitAnswers['provider'] = 'anthropic';
  let baseUrl: string | undefined;

  if (providerResult === 'skip') {
    provider = 'anthropic';
  } else if (typeof providerResult === 'object' && 'custom' in providerResult) {
    provider = 'anthropic'; // fallback if somehow custom returned
  } else if (providerResult === 'custom') {
    // user chose custom — ask for URL then use openai-compat
    output.write('  Base URL (e.g. http://localhost:8080/v1): ');
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input, output, terminal: false });
    baseUrl = await new Promise<string>((resolve) => {
      rl.question('', (ans: string) => { rl.close(); resolve(ans.trim()); });
    });
    provider = 'openai'; // openai-compat with custom baseUrl
  } else {
    provider = providerResult as InitAnswers['provider'];
  }

  // Q2: API key (skip for ollama)
  let envKey: string | undefined;
  if (provider !== 'ollama') {
    const envVar = PROVIDER_ENV_VARS[provider];
    const envVal = envVar ? process.env[envVar] : undefined;
    if (envVal) {
      // Prompt is secret-carrying: use masked input so the override value is never echoed.
      let typed = '';
      try {
        typed = await promptMaskedKey({
          prompt: `  Using ${envVar} from environment (Enter to accept or type key): `,
          input: input as NodeJS.ReadStream,
          output,
          allowEmpty: true,
        });
      } catch {
        // non-interactive or cancelled — fall back to env value silently
      }
      envKey = typed.length > 0 ? typed : envVal;
    } else {
      // No env var — prompt directly via keyPrompt
      try {
        envKey = await promptApiKey({
          provider,
          input: input as NodeJS.ReadStream,
          output,
        });
      } catch (err) {
        if (err instanceof NimbusError && err.context['reason'] === 'non_interactive') {
          output.write(`  (non-interactive; run \`nimbus key set ${provider}\` later)\n`);
        } else if (!(err instanceof NimbusError && err.context['reason'] === 'empty_key')) {
          throw err;
        }
      }
    }
  }

  // Q3: language picker (skippable, default English)
  const langItems = [
    { value: 'en' as const, label: 'English' },
    { value: 'vi' as const, label: 'Tiếng Việt' },
  ];
  const langResult = await pickOne('Language', langItems, { default: 0, allowSkip: true }, { input, output });
  const language: 'en' | 'vi' = (langResult === 'skip' || langResult === 'en') ? 'en'
    : typeof langResult === 'string' ? langResult as 'en' | 'vi'
    : 'en';

  // Infer endpoint for non-anthropic providers
  const endpoint = (provider === 'openai' || provider === 'groq' || provider === 'deepseek' || provider === 'ollama' || provider === 'gemini')
    ? provider
    : (baseUrl ? 'custom' : undefined);

  const answers = InitAnswersSchema.parse({
    workspaceName: 'personal',
    primaryUseCase: 'daily assistant',
    voice: 'casual',
    language,
    provider,
    modelClass: 'workhorse',
    bashPreset: 'balanced',
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  return { answers, envKey };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateLocation(loc: string): string {
  // Reject traversal tokens in the raw input (SPEC-901: "`../etc` rejected").
  const rawParts = loc.split(/[\\/]/);
  if (rawParts.includes('..')) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'location_traversal', loc });
  }
  if (!isAbsolute(loc)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'location_not_absolute', loc });
  }
  const abs = normalize(loc);
  const banned = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc'];
  for (const b of banned) {
    if (abs === b || abs.startsWith(`${b}/`)) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'location_forbidden', loc: abs });
    }
  }
  const home = homedir();
  if (!abs.startsWith(home) && !abs.startsWith('/tmp') && !abs.startsWith('/var/')) {
    // allow, but warn (could be external mount)
  }
  return abs;
}

async function writeAllFiles(
  rootDir: string,
  files: Record<string, string>,
  force: boolean,
  write: (s: string) => void,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(rootDir, name);
    const exists = await fileExists(path);
    if (exists && !force) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'file_exists',
        path,
        hint: 'use --force to overwrite',
      });
    }
    await writeFile(path, content, { encoding: 'utf8' });
    if (detect().os !== 'win32') {
      if (name === 'SOUL.md' || name === 'IDENTITY.md' || name === 'MEMORY.md') {
        await chmod(path, 0o600).catch(() => undefined);
      }
    }
    write(`  wrote ${name}\n`);
  }

  // .dreams/ at 0700
  const dreamsDir = join(rootDir, '.dreams');
  await mkdir(dreamsDir, { recursive: true });
  if (detect().os !== 'win32') {
    await chmod(dreamsDir, 0o700).catch(() => undefined);
  }
  write(`  created .dreams/\n`);
}

export async function runInit(opts: InitRunOpts = {}): Promise<void> {
  const write = (s: string): void => {
    (opts.output ?? process.stdout).write(s);
  };

  write(`\n  nimbus init — create a new workspace\n\n`);

  // v0.2.1: auto-provision vault passphrase BEFORE any key save attempt.
  await autoProvisionPassphrase({
    input: opts.input,
    output: opts.output,
  });

  let answers: InitAnswers;
  let fastEnvKey: string | undefined;

  if (opts.noPrompt) {
    const merged = {
      workspaceName: 'personal',
      primaryUseCase: 'daily assistant',
      voice: 'casual',
      language: 'en',
      provider: 'anthropic',
      modelClass: 'workhorse',
      bashPreset: 'balanced',
      ...opts.answers,
    };
    answers = InitAnswersSchema.parse(merged);
  } else if (opts.advanced) {
    // --advanced: preserve full 7-question wizard
    answers = await askAll({
      ...(opts.input ? { input: opts.input } : {}),
      ...(opts.output ? { output: opts.output } : {}),
    });
  } else {
    // Default fast path: 3 prompts only
    const fast = await askFast({
      ...(opts.input ? { input: opts.input } : {}),
      ...(opts.output ? { output: opts.output } : {}),
    });
    answers = fast.answers;
    fastEnvKey = fast.envKey;
  }

  if (opts.location) {
    validateLocation(opts.location);
  }

  // Create workspace via SPEC-101 store (generates ULID, registers under workspacesDir).
  let meta;
  try {
    const res = await createWorkspaceDir({
      name: answers.workspaceName,
      defaultProvider: answers.provider === 'anthropic' ? 'anthropic' : 'openai-compat',
      defaultModel: resolveModelName(answers.provider, answers.modelClass),
      ...(answers.endpoint !== undefined ? { defaultEndpoint: answers.endpoint } : {}),
      ...(answers.baseUrl !== undefined ? { defaultBaseUrl: answers.baseUrl } : {}),
    });
    meta = res.meta;
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.U_BAD_COMMAND) {
      if (err.context['reason'] === 'duplicate_name') {
        if (opts.force) {
          write(`${'\n'}  workspace "${answers.workspaceName}" exists — overwriting files\n`);
          return overwriteExisting(answers, opts, write);
        }
        throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
          reason: 'workspace_exists',
          name: answers.workspaceName,
          hint: 'use --force to overwrite',
        });
      }
    }
    throw err;
  }

  // Render + write 6 files at workspace root, overwriting the store-created stubs.
  const { paths } = await loadWorkspace(meta.id);
  const files = renderTemplates(answers, todayIso());
  await writeAllFiles(paths.root, files, true, write);

  await switchWorkspace(meta.id);

  // SPEC-902 T4b: provider key step — skipped for ollama (local, keyless).
  // Fast path: if key was collected during askFast(), pass it directly.
  let liveKey: string | undefined;
  if (!opts.skipKeyStep && answers.provider !== 'ollama') {
    const optsWithFastKey = fastEnvKey ? { ...opts, apiKey: fastEnvKey } : opts;
    liveKey = await runKeyStep(answers, meta.id, optsWithFastKey, write);
  }

  // SPEC-903 T7: model discovery picker — post-key so fetchers can auth.
  if (!opts.skipModelPicker && !opts.noPrompt) {
    await runModelPicker(answers, meta.id, liveKey, opts, write);
  }

  write(`\n${'  '}workspace "${answers.workspaceName}" created at ${paths.root}\n`);

  logger.info({ wsId: meta.id, name: answers.workspaceName }, 'init_wizard_completed');
}

async function runKeyStep(
  answers: InitAnswers,
  wsId: string,
  opts: InitRunOpts,
  write: (s: string) => void,
): Promise<string | undefined> {
  let key: string | undefined = opts.apiKey;
  if (!key && opts.noPrompt) {
    // No-prompt mode without a provided key → skip silently; user can run `nimbus key set` later.
    write(`  (no key provided; run \`nimbus key set ${answers.provider}\` later)\n`);
    return undefined;
  }
  if (!key) {
    try {
      key = await promptApiKey({
        provider: answers.provider,
        ...(opts.input ? { input: opts.input as NodeJS.ReadStream } : {}),
        ...(opts.output ? { output: opts.output } : {}),
      });
    } catch (err) {
      if (err instanceof NimbusError && err.code === ErrorCode.U_BAD_COMMAND && err.context['reason'] === 'non_interactive') {
        write(`  (non-interactive; run \`nimbus key set ${answers.provider}\` later)\n`);
        return undefined;
      }
      throw err;
    }
  }
  try {
    validateKeyFormat(answers.provider, key);
  } catch (err) {
    if (err instanceof NimbusError) {
      write(`  key format invalid for ${answers.provider} — skipping store (run \`nimbus key set\` later)\n`);
      return undefined;
    }
    throw err;
  }
  const manager = opts.keyManager ?? createKeyManager();
  await manager.set(answers.provider, key, { wsId });
  write(`  stored ${answers.provider} key\n`);
  return key;
}

async function runModelPicker(
  answers: InitAnswers,
  wsId: string,
  liveKey: string | undefined,
  opts: InitRunOpts,
  write: (s: string) => void,
): Promise<void> {
  const discoverProvider: DiscoverProvider =
    answers.provider === 'anthropic'
      ? 'anthropic'
      : answers.provider === 'ollama'
        ? 'ollama'
        : 'openai-compat';

  const baseUrl = resolveBaseUrl(answers);
  if (!baseUrl) {
    logger.debug({ provider: answers.provider }, 'model_picker_no_base_url');
    return;
  }

  const apiKey = liveKey ?? opts.apiKey;
  const discoveredAt = performance.now();
  let result;
  try {
    result = await discoverModels({
      provider: discoverProvider,
      providerTag: answers.provider,
      baseUrl,
      apiKey: apiKey ?? null,
      timeoutMs: 5_000,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'model_picker_discover_failed',
    );
    return;
  }
  logger.debug(
    {
      source: result.source,
      count: result.models.length,
      elapsedMs: Math.round(performance.now() - discoveredAt),
    },
    'model_picker_discover_done',
  );

  const banner =
    result.source === 'curated' || result.source === 'empty'
      ? 'using curated list, may be stale'
      : undefined;

  const picked = await pickModel(result.models, {
    prompt: 'Select default model',
    ...(banner !== undefined ? { banner } : {}),
    io: {
      ...(opts.input ? { input: opts.input as NodeJS.ReadStream } : {}),
      ...(opts.output ? { output: opts.output as NodeJS.WriteStream } : {}),
    },
  });

  if (picked.kind === 'skipped') {
    write(`  (kept default model: ${resolveModelName(answers.provider, answers.modelClass)})\n`);
    return;
  }
  const chosenId = picked.kind === 'selected' ? picked.id : picked.id;
  if (!chosenId) return;
  await updateWorkspace(wsId, { defaultModel: chosenId });
  write(`  default model: ${chosenId}\n`);
}

function resolveBaseUrl(answers: InitAnswers): string | null {
  if (answers.provider === 'anthropic') return 'https://api.anthropic.com';
  if (answers.baseUrl) return answers.baseUrl;
  if (answers.provider === 'openai') return 'https://api.openai.com/v1';
  if (answers.provider === 'groq') return 'https://api.groq.com/openai/v1';
  if (answers.provider === 'deepseek') return 'https://api.deepseek.com/v1';
  if (answers.provider === 'ollama') return 'http://localhost:11434/v1';
  return null;
}

async function overwriteExisting(
  answers: InitAnswers,
  opts: InitRunOpts,
  write: (s: string) => void,
): Promise<void> {
  const { listWorkspaces } = await import('../storage/workspaceStore.ts');
  const all = await listWorkspaces();
  const existing = all.find((w) => w.name === answers.workspaceName);
  if (!existing) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, { reason: 'workspace_not_found', name: answers.workspaceName });
  }
  const { paths } = await loadWorkspace(existing.id);
  const files = renderTemplates(answers, todayIso());
  await writeAllFiles(paths.root, files, true, write);
  await switchWorkspace(existing.id);
  write(`\n${'  '}workspace "${answers.workspaceName}" updated at ${paths.root}\n\n`);
}

function resolveModelName(
  provider: InitAnswers['provider'],
  klass: InitAnswers['modelClass'],
): string {
  if (provider === 'anthropic') {
    if (klass === 'flagship') return 'claude-opus-4-6';
    if (klass === 'budget') return 'claude-haiku-4-5-20251001';
    return 'claude-sonnet-4-6';
  }
  if (provider === 'openai') {
    if (klass === 'flagship') return 'gpt-4o';
    if (klass === 'budget') return 'gpt-5.4-mini';
    return 'gpt-5.4-mini';
  }
  if (provider === 'groq') return 'llama-3.3-70b-versatile';
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'ollama') return 'llama3.2';
  return 'claude-sonnet-4-6';
}

// ---------------------------------------------------------------------------
// Quick-init: "paste key → go" used by the auto-first-run path in cli.ts.
// Creates only 2 files: workspace.json + SOUL.md.  No wizard, no .dreams/.
// ---------------------------------------------------------------------------

export interface QuickInitResult {
  wsId: string;
  name: string;
  provider: string;
  model: string;
}

/**
 * detectEnvKey — check common env vars and return the first found key + provider.
 * Priority: ANTHROPIC_API_KEY → OPENAI_API_KEY → GROQ_API_KEY.
 */
export function detectEnvKey(): { key: string; envVar: string } | null {
  const candidates = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
  ] as const;
  for (const envVar of candidates) {
    const val = process.env[envVar];
    if (val && val.length > 0) return { key: val, envVar };
  }
  return null;
}

/**
 * quickInit — minimal workspace creation for the auto-first-run path.
 * Only creates workspace.json + SOUL.md (no IDENTITY/MEMORY/TOOLS/DREAMS/CLAUDE).
 * Optionally stores the API key in the vault if provided.
 */
export async function quickInit(
  detected: { provider: string; defaultModel: string; kind: 'anthropic' | 'openai-compat'; defaultEndpoint?: string; defaultBaseUrl?: string },
  apiKey: string | undefined,
  opts: { keyManager?: KeyManager; output?: NodeJS.WritableStream } = {},
): Promise<QuickInitResult> {
  const write = (s: string): void => {
    (opts.output ?? process.stdout).write(s);
  };

  // Auto-provision vault passphrase before saving any keys.
  await autoProvisionPassphrase({ output: opts.output });

  const today = todayIso();

  // Create workspace dir + workspace.json
  const { meta } = await createWorkspaceDir({
    name: 'personal',
    defaultProvider: detected.kind,
    defaultModel: detected.defaultModel,
    ...(detected.defaultEndpoint !== undefined ? { defaultEndpoint: detected.defaultEndpoint as 'openai' | 'groq' | 'deepseek' | 'ollama' | 'custom' } : {}),
    ...(detected.defaultBaseUrl !== undefined ? { defaultBaseUrl: detected.defaultBaseUrl } : {}),
  });

  // Write SOUL.md — overwrite the stub written by createWorkspaceDir
  const { paths } = await loadWorkspace(meta.id);
  const soulContent = DEFAULT_SOUL_MD(today);
  await writeFile(paths.soulMd, soulContent, { encoding: 'utf8' });
  if (detect().os !== 'win32') {
    await chmod(paths.soulMd, 0o600).catch(() => undefined);
  }

  // Remove the extra stub files that createWorkspaceDir writes — quickInit is 2-file only.
  for (const stub of [paths.identityMd, paths.memoryMd, paths.toolsMd]) {
    await rm(stub, { force: true }).catch(() => undefined);
  }

  await switchWorkspace(meta.id);

  // Store API key if provided
  if (apiKey) {
    try {
      const manager = opts.keyManager ?? createKeyManager();
      await manager.set(detected.provider, apiKey, { wsId: meta.id });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'quick_init_key_store_failed',
      );
      write(`  (key store failed — run \`nimbus key set ${detected.provider}\` later)\n`);
    }
  }

  logger.info({ wsId: meta.id, provider: detected.provider }, 'quick_init_completed');
  return { wsId: meta.id, name: meta.name, provider: detected.provider, model: meta.defaultModel };
}

export const __testing = { validateLocation, resolveModelName, todayIso, detectEnvKey };
