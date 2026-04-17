// runInkInit.ts — SPEC-855: Factory that mounts <Onboarding> and waits for completion.
// Calls quickInit() on success to materialize the workspace.
// Draft resume: if ~/.nimbus/init-draft.json exists, load + offer resume.

import React from 'react';
import { render } from 'ink';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { Onboarding } from './Onboarding.tsx';
import type { WizardAnswers, InitResult } from './Onboarding.tsx';
import { quickInit } from '../init.ts';
import { nimbusHome } from '../../platform/paths.ts';
import { logger } from '../../observability/logger.ts';
export interface RunInkInitOpts {
  /** Override draft path (for testing) */
  draftPath?: string;
  /** Pre-filled answers from CLI flags */
  prefill?: WizardAnswers;
}

async function loadDraft(draftPath: string): Promise<{ step: string; answers: WizardAnswers } | null> {
  try {
    const raw = await readFile(draftPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'answers' in parsed &&
      typeof (parsed as Record<string, unknown>)['answers'] === 'object'
    ) {
      return parsed as { step: string; answers: WizardAnswers };
    }
  } catch {
    // no draft or unreadable — start fresh
  }
  return null;
}

async function cleanDraft(draftPath: string): Promise<void> {
  await unlink(draftPath).catch(() => undefined);
}

export async function runInkInit(opts: RunInkInitOpts = {}): Promise<void> {
  const draftPath = opts.draftPath ?? join(nimbusHome(), 'init-draft.json');

  // Check for draft from previous aborted run
  const draft = await loadDraft(draftPath);
  const initialAnswers: WizardAnswers = draft?.answers ?? opts.prefill ?? {};

  return new Promise<void>((resolve, reject) => {
    let completed = false;

    const handleComplete = (result: InitResult): void => {
      completed = true;
      instance.unmount();

      // Fire-and-forget cleanup + workspace creation
      void (async () => {
        await cleanDraft(draftPath);

        // Resolve provider metadata for quickInit
        const kind: 'anthropic' | 'openai-compat' =
          result.provider === 'anthropic' ? 'anthropic' : 'openai-compat';

        const defaultModel = resolveModelName(result.provider, result.modelClass);

        try {
          await quickInit(
            {
              provider: result.provider,
              defaultModel,
              kind,
              ...(result.endpoint !== undefined ? { defaultEndpoint: result.endpoint as 'openai' | 'groq' | 'deepseek' | 'ollama' | 'gemini' | 'custom' } : {}),
              ...(result.baseUrl !== undefined ? { defaultBaseUrl: result.baseUrl } : {}),
            },
            undefined, // API key stored by KeyStep via vault; quickInit handles key-less case
          );
          logger.info({ provider: result.provider, locale: result.locale }, 'ink_init_completed');
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    };

    const handleAbort = (): void => {
      if (!completed) {
        instance.unmount();
        process.stdout.write('\n  Init aborted. Draft saved — re-run `nimbus init` to resume.\n');
        resolve();
      }
    };

    const element = React.createElement(Onboarding, {
      draftPath,
      initialAnswers,
      onComplete: handleComplete,
      onAbort: handleAbort,
    });

    const instance = render(element, { exitOnCtrlC: false });

    // Handle external unmount (e.g. SIGINT from OS)
    instance.waitUntilExit().catch((err: unknown) => {
      if (!completed) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function resolveModelName(provider: string, klass: 'flagship' | 'workhorse' | 'budget'): string {
  if (provider === 'anthropic') {
    if (klass === 'flagship') return 'claude-opus-4-6';
    if (klass === 'budget') return 'claude-haiku-4-5-20251001';
    return 'claude-sonnet-4-6';
  }
  if (provider === 'openai') {
    if (klass === 'flagship') return 'gpt-4o';
    return 'gpt-5.4-mini';
  }
  if (provider === 'groq') return 'llama-3.3-70b-versatile';
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'ollama') return 'llama3.2';
  return 'claude-sonnet-4-6';
}

// Exported for tests
export { resolveModelName };
