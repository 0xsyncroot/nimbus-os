import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { anthropicFetcher } from '../../src/catalog/fetchers/anthropic';
import {
  OPENAI_COMPAT_CHAT_RE,
  openaiCompatFetcher,
} from '../../src/catalog/fetchers/openaiCompat';
import {
  ollamaFetcher,
  normalizeOllamaBase,
} from '../../src/catalog/fetchers/ollama';

type FetchFn = typeof fetch;
const originalFetch: FetchFn = globalThis.fetch;

function mockFetchOnce(response: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throwError?: Error;
  delayMs?: number;
}): void {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    if (response.throwError) throw response.throwError;
    if (response.delayMs !== undefined) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, response.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const bodyStr =
      typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? {});
    return new Response(bodyStr, {
      status: response.status ?? 200,
      headers: response.headers ?? { 'content-type': 'application/json' },
    });
  }) as FetchFn;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SPEC-903: anthropicFetcher', () => {
  test('happy path 200 + data[]', async () => {
    mockFetchOnce({
      body: {
        data: [
          { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', type: 'model' },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model' },
        ],
      },
    });
    const res = await anthropicFetcher.fetch(
      'https://api.anthropic.com',
      'sk-ant-xxx',
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.models).toHaveLength(2);
      expect(res.models[0]!.id).toBe('claude-opus-4-6');
      expect(res.models[0]!.displayName).toBe('Claude Opus 4.6');
      expect(res.models[0]!.source).toBe('live');
    }
  });

  test('401 → auth', async () => {
    mockFetchOnce({ status: 401, body: { error: { message: 'bad key' } } });
    const res = await anthropicFetcher.fetch('https://api.anthropic.com', 'bad', {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });

  test('malformed JSON → parse', async () => {
    mockFetchOnce({ body: 'not json at all', headers: { 'content-type': 'text/plain' } });
    const res = await anthropicFetcher.fetch('https://api.anthropic.com', 'sk-ant', {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('parse');
  });

  test('missing apiKey → auth (no network call)', async () => {
    mockFetchOnce({ throwError: new Error('should not be called') });
    const res = await anthropicFetcher.fetch('https://api.anthropic.com', null, {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });

  test('timeout → timeout reason', async () => {
    mockFetchOnce({ delayMs: 500, body: {} });
    const res = await anthropicFetcher.fetch('https://api.anthropic.com', 'sk-ant', {
      timeoutMs: 50,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timeout');
  });
});

describe('SPEC-903: openaiCompatFetcher', () => {
  test('filters embeddings/TTS/whisper, keeps chat models', async () => {
    mockFetchOnce({
      body: {
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4o-mini' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'dall-e-3' },
          { id: 'tts-1' },
          { id: 'o1-mini' },
          { id: 'llama-3.3-70b' },
        ],
      },
    });
    const res = await openaiCompatFetcher.fetch(
      'https://api.openai.com/v1',
      'sk-xxx',
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = res.models.map((m) => m.id).sort();
      expect(ids).toEqual(
        ['gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b', 'o1-mini'].sort(),
      );
    }
  });

  test('regex allowlist: direct asserts', () => {
    expect(OPENAI_COMPAT_CHAT_RE.test('gpt-4o')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('gpt-4-turbo')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('o1-preview')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('claude-sonnet-4-6')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('llama-3.3-70b')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('mixtral-8x7b')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('qwen-2.5')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('deepseek-chat')).toBe(true);
    expect(OPENAI_COMPAT_CHAT_RE.test('text-embedding-3-small')).toBe(false);
    expect(OPENAI_COMPAT_CHAT_RE.test('whisper-1')).toBe(false);
    expect(OPENAI_COMPAT_CHAT_RE.test('dall-e-3')).toBe(false);
    expect(OPENAI_COMPAT_CHAT_RE.test('tts-1')).toBe(false);
  });

  test('401 → auth', async () => {
    mockFetchOnce({ status: 401 });
    const res = await openaiCompatFetcher.fetch(
      'https://api.openai.com/v1',
      'bad',
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth');
  });

  test('missing data field → parse', async () => {
    mockFetchOnce({ body: { something_else: true } });
    const res = await openaiCompatFetcher.fetch(
      'https://api.openai.com/v1',
      'sk',
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('parse');
  });
});

describe('SPEC-903: ollamaFetcher', () => {
  test('happy path with /api/tags', async () => {
    mockFetchOnce({
      body: {
        models: [
          { name: 'llama3.2', model: 'llama3.2', size: 1000 },
          { name: 'qwen2.5-coder:7b' },
        ],
      },
    });
    const res = await ollamaFetcher.fetch(
      'http://localhost:11434',
      null,
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.models.map((m) => m.id)).toEqual(['llama3.2', 'qwen2.5-coder:7b']);
      expect(res.models[0]!.provider).toBe('ollama');
    }
  });

  test('normalizeOllamaBase strips /v1 suffix', () => {
    expect(normalizeOllamaBase('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(normalizeOllamaBase('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeOllamaBase('http://localhost:11434')).toBe('http://localhost:11434');
  });

  test('empty models array → ok:true with []', async () => {
    mockFetchOnce({ body: { models: [] } });
    const res = await ollamaFetcher.fetch('http://localhost:11434', null, {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.models).toHaveLength(0);
  });

  test('malformed (missing models field) → parse', async () => {
    mockFetchOnce({ body: { other: 1 } });
    const res = await ollamaFetcher.fetch('http://localhost:11434', null, {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('parse');
  });

  test('network error → network', async () => {
    mockFetchOnce({ throwError: new Error('ECONNREFUSED') });
    const res = await ollamaFetcher.fetch('http://localhost:11434', null, {
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
  });
});
