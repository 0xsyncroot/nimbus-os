import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverModels } from '../../src/catalog/discover';
import { catalogDir } from '../../src/catalog/store';

type FetchFn = typeof fetch;
const originalFetch: FetchFn = globalThis.fetch;

function mockFetch(response: {
  status?: number;
  body?: unknown;
  throwError?: Error;
  headers?: Record<string, string>;
}): void {
  globalThis.fetch = (async () => {
    if (response.throwError) throw response.throwError;
    const body =
      typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? {});
    return new Response(body, {
      status: response.status ?? 200,
      headers: response.headers ?? { 'content-type': 'application/json' },
    });
  }) as unknown as FetchFn;
}

beforeEach(async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'nimbus-discover-'));
  process.env['NIMBUS_HOME'] = sandbox;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SPEC-903: discoverModels orchestrator', () => {
  test('live fetch → models cached + source=live', async () => {
    mockFetch({
      body: {
        data: [{ id: 'claude-opus-4-6', display_name: 'Opus', type: 'model' }],
      },
    });
    const res = await discoverModels({
      provider: 'anthropic',
      providerTag: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-x',
    });
    expect(res.source).toBe('live');
    expect(res.models).toHaveLength(1);
    expect(res.staleBanner).toBe(false);

    // cache was written
    const entries = await readdir(catalogDir());
    expect(entries.length).toBeGreaterThan(0);
  });

  test('cache hit on second call → source=cache, no fetch needed', async () => {
    // First call writes cache.
    mockFetch({ body: { data: [{ id: 'gpt-4o' }] } });
    await discoverModels({
      provider: 'openai-compat',
      providerTag: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
    });

    // Second call — fetch raises (should not be called).
    mockFetch({ throwError: new Error('should not call') });
    const res = await discoverModels({
      provider: 'openai-compat',
      providerTag: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
    });
    expect(res.source).toBe('cache');
    expect(res.models[0]!.id).toBe('gpt-4o');
  });

  test('fetch fail + no cache → curated fallback + staleBanner', async () => {
    mockFetch({ throwError: new Error('ECONNREFUSED') });
    const res = await discoverModels({
      provider: 'openai-compat',
      providerTag: 'anthropic', // providerTag anthropic so curatedFallback returns anthropic rows
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-x',
    });
    expect(res.source).toBe('curated');
    expect(res.staleBanner).toBe(true);
    expect(res.models.length).toBeGreaterThan(0);
  });

  test('refresh=true bypasses cache', async () => {
    mockFetch({ body: { data: [{ id: 'gpt-4o' }] } });
    await discoverModels({
      provider: 'openai-compat',
      providerTag: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
    });

    mockFetch({ body: { data: [{ id: 'gpt-4o' }, { id: 'o1-mini' }] } });
    const res = await discoverModels({
      provider: 'openai-compat',
      providerTag: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      refresh: true,
    });
    expect(res.source).toBe('live');
    expect(res.models).toHaveLength(2);
  });

  test('fetch returns 0 models → curated fallback', async () => {
    mockFetch({ body: { data: [] } });
    const res = await discoverModels({
      provider: 'anthropic',
      providerTag: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant',
    });
    // Anthropic empty response → fallback (live+0 treated as failure).
    expect(res.source).toBe('curated');
    expect(res.models.length).toBeGreaterThan(0);
  });

  test('cache files contain no api key prefixes (leak guard)', async () => {
    mockFetch({ body: { data: [{ id: 'claude-opus', type: 'model' }] } });
    await discoverModels({
      provider: 'anthropic',
      providerTag: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-very-secret-key',
    });
    const dir = catalogDir();
    const files = await readdir(dir);
    for (const f of files) {
      const content = await readFile(join(dir, f), 'utf8');
      expect(content).not.toContain('sk-ant-very-secret-key');
      expect(content.toLowerCase()).not.toContain('bearer ');
    }
  });
});
