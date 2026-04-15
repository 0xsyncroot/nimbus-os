// init.ts — SPEC-901 T4/T5: orchestrate init wizard → workspace + 6 files + .dreams/.

import { join, isAbsolute, normalize } from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { detect } from '../platform/detect.ts';
import {
  createWorkspaceDir,
  loadWorkspace,
  fileExists,
} from '../storage/workspaceStore.ts';
import { switchWorkspace } from '../core/workspace.ts';
import { askAll, InitAnswersSchema, type InitAnswers } from './questions.ts';
import { renderTemplates } from './templates.ts';
import { promptApiKey } from './keyPrompt.ts';
import { validateKeyFormat } from './keyValidators.ts';
import { createKeyManager, type KeyManager } from '../key/manager.ts';

export interface InitRunOpts {
  force?: boolean;
  noPrompt?: boolean;
  location?: string;
  answers?: Partial<InitAnswers>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  skipKeyStep?: boolean;
  keyManager?: KeyManager;
  apiKey?: string;
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

  let answers: InitAnswers;
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
  } else {
    answers = await askAll({
      ...(opts.input ? { input: opts.input } : {}),
      ...(opts.output ? { output: opts.output } : {}),
    });
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
  if (!opts.skipKeyStep && answers.provider !== 'ollama') {
    await runKeyStep(answers, meta.id, opts, write);
  }

  write(`\n${'  '}workspace "${answers.workspaceName}" created at ${paths.root}\n`);
  write(`${'  '}now run \`nimbus\` to start chatting.\n\n`);

  logger.info({ wsId: meta.id, name: answers.workspaceName }, 'init_wizard_completed');
}

async function runKeyStep(
  answers: InitAnswers,
  wsId: string,
  opts: InitRunOpts,
  write: (s: string) => void,
): Promise<void> {
  let key: string | undefined = opts.apiKey;
  if (!key && opts.noPrompt) {
    // No-prompt mode without a provided key → skip silently; user can run `nimbus key set` later.
    write(`  (no key provided; run \`nimbus key set ${answers.provider}\` later)\n`);
    return;
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
        return;
      }
      throw err;
    }
  }
  try {
    validateKeyFormat(answers.provider, key);
  } catch (err) {
    if (err instanceof NimbusError) {
      write(`  key format invalid for ${answers.provider} — skipping store (run \`nimbus key set\` later)\n`);
      return;
    }
    throw err;
  }
  const manager = opts.keyManager ?? createKeyManager();
  await manager.set(answers.provider, key, { wsId });
  write(`  stored ${answers.provider} key\n`);
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
    if (klass === 'budget') return 'gpt-4o-mini';
    return 'gpt-4o';
  }
  if (provider === 'groq') return 'llama-3.3-70b-versatile';
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'ollama') return 'llama3.2';
  return 'claude-sonnet-4-6';
}

export const __testing = { validateLocation, resolveModelName, todayIso };
