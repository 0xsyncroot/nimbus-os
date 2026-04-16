// modelPicker.ts — SPEC-801/SPEC-903: interactive model picker for /model (no-arg).
// Calls discoverModels, falls back to curated list on failure, shows pickModel TTY picker.

import { discoverModels, type DiscoverProvider } from '../../catalog/discover.ts';
import { pickModel } from '../../catalog/picker.ts';
import { updateWorkspace } from '../../storage/workspaceStore.ts';
import type { Workspace } from '../../core/workspaceTypes.ts';

export interface ModelPickerContext {
  workspace: Workspace;
  /** resolved API key for the active provider (may be undefined if not yet set) */
  apiKey: string | undefined;
  output: NodeJS.WritableStream;
  input: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
}

/**
 * Show loading indicator, call discoverModels, present interactive picker.
 * Falls back to curated list on discovery failure.
 * On successful selection, patches workspace.json defaultModel.
 * Returns the selected model id, or undefined if skipped.
 */
export async function handleModelPicker(ctx: ModelPickerContext): Promise<string | undefined> {
  const { workspace, apiKey, output, input } = ctx;
  const write = (s: string): void => { output.write(s); };

  // Derive discover parameters from workspace.
  const provider = resolveDiscoverProvider(workspace.defaultProvider);
  const baseUrl = workspace.defaultBaseUrl ?? providerDefaultBaseUrl(provider, workspace.defaultEndpoint);
  const providerTag = workspace.defaultEndpoint ?? workspace.defaultProvider;

  write(`Loading models from ${providerTag}...\n`);

  const result = await discoverModels({
    provider,
    providerTag,
    baseUrl,
    apiKey: apiKey ?? null,
  });

  let banner: string | undefined;
  if (result.staleBanner) {
    const reason = result.reason ? ` (${result.reason})` : '';
    banner = result.source === 'curated'
      ? `discovery failed${reason}, using curated list`
      : `using stale cache${reason}`;
  }

  const picked = await pickModel(result.models, {
    prompt: 'Select model',
    banner,
    io: { input, output },
  });

  if (picked.kind === 'skipped') {
    write('model unchanged\n');
    return undefined;
  }

  const modelId = picked.kind === 'selected' ? picked.id : picked.id;
  await updateWorkspace(workspace.id, { defaultModel: modelId });
  write(`model set to ${modelId}\n`);
  return modelId;
}

function resolveDiscoverProvider(defaultProvider: string): DiscoverProvider {
  if (defaultProvider === 'anthropic') return 'anthropic';
  // openai-compat covers openai, groq, deepseek, custom, etc.
  return 'openai-compat';
}

function providerDefaultBaseUrl(
  provider: DiscoverProvider,
  endpoint?: string,
): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (endpoint === 'groq') return 'https://api.groq.com/openai';
  if (endpoint === 'deepseek') return 'https://api.deepseek.com';
  if (endpoint === 'ollama') return 'http://localhost:11434';
  return 'https://api.openai.com';
}
