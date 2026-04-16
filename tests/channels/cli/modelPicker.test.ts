// modelPicker.test.ts — SPEC-801/SPEC-903: tests for handleModelPicker.

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { ModelDescriptor } from '../../../src/catalog/types.ts';
import type { Workspace } from '../../../src/core/workspaceTypes.ts';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const THREE_MODELS: ModelDescriptor[] = [
  { id: 'claude-opus-4-6', provider: 'anthropic', source: 'live', classHint: 'flagship' },
  { id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'live', classHint: 'workhorse' },
  { id: 'claude-haiku-4-5', provider: 'anthropic', source: 'live', classHint: 'budget' },
];

const CURATED_MODELS: ModelDescriptor[] = [
  { id: 'gpt-4o', provider: 'openai', source: 'curated' },
  { id: 'gpt-4o-mini', provider: 'openai', source: 'curated' },
];

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    schemaVersion: 1,
    id: '01HWXXXXXXXXXXXXXXXXXX1234',
    name: 'test-ws',
    createdAt: 1_000_000,
    lastUsed: 1_000_000,
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    ...overrides,
  };
}

function makeIO(answers: string[]): {
  input: PassThrough & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  output: PassThrough & { isTTY?: boolean };
  captured: () => string;
} {
  const input = new PassThrough() as PassThrough & {
    setRawMode?: (raw: boolean) => unknown;
    isTTY?: boolean;
  };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  let out = '';
  output.on('data', (chunk: Buffer | string) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  for (const a of answers) {
    input.write(`${a}\n`);
  }
  input.end();
  return { input, output, captured: () => out };
}

// ---------------------------------------------------------------------------
// Mock discoverModels and updateWorkspace via module mocking.
// We use mock.module to replace the catalog/discover and storage/workspaceStore
// modules before importing modelPicker.
// ---------------------------------------------------------------------------

describe('SPEC-801/SPEC-903: handleModelPicker — live discovery → select 2nd model', () => {
  test('picker returns 2nd model, workspace.json updated', async () => {
    const updates: Record<string, unknown>[] = [];

    mock.module('../../../src/catalog/discover.ts', () => ({
      discoverModels: async () => ({
        models: THREE_MODELS,
        source: 'live' as const,
        staleBanner: false,
      }),
    }));

    mock.module('../../../src/storage/workspaceStore.ts', () => ({
      updateWorkspace: async (id: string, patch: Partial<Workspace>) => {
        updates.push({ id, patch });
        return { ...makeWorkspace(), ...patch };
      },
    }));

    const { handleModelPicker } = await import('../../../src/channels/cli/modelPicker.ts');

    const ws = makeWorkspace();
    const { input, output, captured } = makeIO(['2']); // pick 2nd (claude-sonnet-4-6)

    const result = await handleModelPicker({ workspace: ws, apiKey: 'sk-test', output, input });

    expect(result).toBe('claude-sonnet-4-6');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: ws.id, patch: { defaultModel: 'claude-sonnet-4-6' } });
    expect(captured()).toContain('Loading models from');
    expect(captured()).toContain('model set to claude-sonnet-4-6');
  });
});

describe('SPEC-801/SPEC-903: handleModelPicker — discovery fails → fallback + banner', () => {
  test('shows banner, shows curated list, picker still works', async () => {
    const updates: Record<string, unknown>[] = [];

    mock.module('../../../src/catalog/discover.ts', () => ({
      discoverModels: async () => ({
        models: CURATED_MODELS,
        source: 'curated' as const,
        staleBanner: true,
        reason: 'auth',
      }),
    }));

    mock.module('../../../src/storage/workspaceStore.ts', () => ({
      updateWorkspace: async (id: string, patch: Partial<Workspace>) => {
        updates.push({ id, patch });
        return { ...makeWorkspace(), ...patch };
      },
    }));

    const { handleModelPicker } = await import('../../../src/channels/cli/modelPicker.ts');

    const ws = makeWorkspace({ defaultProvider: 'openai-compat', defaultEndpoint: 'openai' });
    const { input, output, captured } = makeIO(['1']); // pick first (gpt-4o)

    const result = await handleModelPicker({ workspace: ws, apiKey: undefined, output, input });

    expect(result).toBe('gpt-4o');
    const out = captured();
    expect(out).toContain('[MODELS]');
    expect(out).toContain('discovery failed');
    expect(out).toContain('auth');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ patch: { defaultModel: 'gpt-4o' } });
  });
});

describe('SPEC-801/SPEC-903: handleModelPicker — picker skipped → no workspace update', () => {
  test('s → skipped, updateWorkspace not called, returns undefined', async () => {
    const updates: Record<string, unknown>[] = [];

    mock.module('../../../src/catalog/discover.ts', () => ({
      discoverModels: async () => ({
        models: THREE_MODELS,
        source: 'live' as const,
        staleBanner: false,
      }),
    }));

    mock.module('../../../src/storage/workspaceStore.ts', () => ({
      updateWorkspace: async (id: string, patch: Partial<Workspace>) => {
        updates.push({ id, patch });
        return { ...makeWorkspace(), ...patch };
      },
    }));

    const { handleModelPicker } = await import('../../../src/channels/cli/modelPicker.ts');

    const ws = makeWorkspace();
    const { input, output, captured } = makeIO(['s']); // skip

    const result = await handleModelPicker({ workspace: ws, apiKey: 'sk-test', output, input });

    expect(result).toBeUndefined();
    expect(updates).toHaveLength(0);
    expect(captured()).toContain('model unchanged');
  });
});

describe('SPEC-801/SPEC-903: handleModelPicker — custom model id', () => {
  test('c + custom id → updates workspace with custom id', async () => {
    const updates: Record<string, unknown>[] = [];

    mock.module('../../../src/catalog/discover.ts', () => ({
      discoverModels: async () => ({
        models: THREE_MODELS,
        source: 'live' as const,
        staleBanner: false,
      }),
    }));

    mock.module('../../../src/storage/workspaceStore.ts', () => ({
      updateWorkspace: async (id: string, patch: Partial<Workspace>) => {
        updates.push({ id, patch });
        return { ...makeWorkspace(), ...patch };
      },
    }));

    const { handleModelPicker } = await import('../../../src/channels/cli/modelPicker.ts');

    const ws = makeWorkspace();
    const { input, output } = makeIO(['c', 'my-special-model']); // custom

    const result = await handleModelPicker({ workspace: ws, apiKey: 'sk-test', output, input });

    expect(result).toBe('my-special-model');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ patch: { defaultModel: 'my-special-model' } });
  });
});

describe('SPEC-801/SPEC-903: /model slash command routing', () => {
  test('no-arg /model invokes pickModel, not setModel', async () => {
    const { __resetRegistry, registerDefaultCommands, dispatchSlash } = await import(
      '../../../src/channels/cli/slashCommands.ts'
    );
    __resetRegistry();
    registerDefaultCommands();

    let pickerCalled = false;
    const setModelCalls: string[] = [];
    const ctx = {
      wsId: 'ws1',
      write: (_s: string) => { /* silent */ },
      pickModel: async () => { pickerCalled = true; },
      setModel: async (m: string) => { setModelCalls.push(m); },
    };
    await dispatchSlash('/model', ctx);
    expect(pickerCalled).toBe(true);
    expect(setModelCalls).toHaveLength(0);
  });

  test('/model <name> uses setModel, skips pickModel', async () => {
    const { __resetRegistry, registerDefaultCommands, dispatchSlash } = await import(
      '../../../src/channels/cli/slashCommands.ts'
    );
    __resetRegistry();
    registerDefaultCommands();

    let pickerCalled = false;
    const setModelCalls: string[] = [];
    const ctx = {
      wsId: 'ws1',
      write: (_s: string) => { /* silent */ },
      pickModel: async () => { pickerCalled = true; },
      setModel: async (m: string) => { setModelCalls.push(m); },
    };
    await dispatchSlash('/model claude-haiku-4-5', ctx);
    expect(pickerCalled).toBe(false);
    expect(setModelCalls).toEqual(['claude-haiku-4-5']);
  });

  test('/model no-arg without pickModel falls back to setModel("")', async () => {
    const { __resetRegistry, registerDefaultCommands, dispatchSlash } = await import(
      '../../../src/channels/cli/slashCommands.ts'
    );
    __resetRegistry();
    registerDefaultCommands();

    const setModelCalls: string[] = [];
    const ctx = {
      wsId: 'ws1',
      write: (_s: string) => { /* silent */ },
      // no pickModel
      setModel: async (m: string) => { setModelCalls.push(m); },
    };
    await dispatchSlash('/model', ctx);
    expect(setModelCalls).toEqual(['']);
  });
});
