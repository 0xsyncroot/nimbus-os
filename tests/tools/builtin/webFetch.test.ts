// tests/tools/builtin/webFetch.test.ts — SPEC-307 unit tests.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ctxStub } from '../helpers.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';
import {
  createWebFetchTool,
  WebFetchInputSchema,
  type WebFetchOutput,
} from '../../../src/tools/builtin/WebFetch.ts';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
<article><h1>Test Article</h1><p>This is a test article with meaningful content.</p>
<p>Second paragraph with more text.</p></article>
<script>alert('xss')</script>
<style>body { color: red; }</style>
</body></html>`;

const NON_ARTICLE_HTML = `<!DOCTYPE html><html><body>
<div class="nav"><a href="/">Home</a><a href="/about">About</a></div>
<div id="main"><span>Some text</span></div>
<script>doSomething()</script>
</body></html>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function urlKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function buildCacheEntry(url: string, output: WebFetchOutput, tsOffset = 0): string {
  return JSON.stringify({ key: urlKey(url), data: output, ts: Date.now() + tsOffset });
}

// ── Env setup for cache isolation ─────────────────────────────────────────────

let cacheRoot: string;
beforeAll(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'nimbus-webfetch-test-'));
});
afterAll(() => {
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch { /* noop */ }
});
beforeEach(() => {
  const uniqueDir = join(cacheRoot, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['NIMBUS_WEBFETCH_CACHE_DIR'] = uniqueDir;
});
afterEach(() => {
  delete process.env['NIMBUS_WEBFETCH_CACHE_DIR'];
  mock.restore();
});

// ── §1 Input schema validation ────────────────────────────────────────────────

describe('SPEC-307: input schema', () => {
  test('valid HTTPS URL parses', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'https://example.com' });
    expect(result.success).toBe(true);
  });

  test('invalid URL rejected', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  test('default mode is markdown', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mode).toBe('markdown');
  });

  test('default timeout is 15000', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timeout).toBe(15_000);
  });

  test('timeout below 1000 rejected', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'https://example.com', timeout: 500 });
    expect(result.success).toBe(false);
  });

  test('timeout above 30000 rejected', () => {
    const result = WebFetchInputSchema.safeParse({ url: 'https://example.com', timeout: 60_000 });
    expect(result.success).toBe(false);
  });
});

// ── §2 SSRF guard ─────────────────────────────────────────────────────────────

describe('SPEC-307: SSRF guard', () => {
  const tool = createWebFetchTool();
  const ctx = ctxStub({ workspaceId: 'W_SSRF' });

  test('HTTP URL rejected with X_NETWORK_BLOCKED', async () => {
    const result = await tool.handler(
      { url: 'http://example.com', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.X_NETWORK_BLOCKED);
      expect(result.error.context['reason']).toBe('https_required');
    }
  });

  test('127.0.0.1 rejected', async () => {
    const result = await tool.handler(
      { url: 'https://127.0.0.1/path', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.X_NETWORK_BLOCKED);
      expect(result.error.context['reason']).toBe('private_ip_blocked');
    }
  });

  test('169.254.169.254 (cloud metadata) rejected', async () => {
    const result = await tool.handler(
      { url: 'https://169.254.169.254/latest/meta-data/', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.X_NETWORK_BLOCKED);
  });

  test('192.168.x private IP rejected', async () => {
    const result = await tool.handler(
      { url: 'https://192.168.1.1', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.X_NETWORK_BLOCKED);
  });

  test('10.x private IP rejected', async () => {
    const result = await tool.handler(
      { url: 'https://10.0.0.1/api', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.X_NETWORK_BLOCKED);
  });
});

// ── §3 Fetch pipeline with mocked fetch ──────────────────────────────────────

function makeTextStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc);
      controller.close();
    },
  });
}

function mockFetch(html: string, status = 200): void {
  globalThis.fetch = mock(async (_input: unknown, _init?: unknown) => {
    if (status !== 200) {
      return { ok: false, status, body: null } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      body: makeTextStream(html),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('SPEC-307: fetch pipeline', () => {
  test('200 article HTML → markdown output, no raw tags', async () => {
    mockFetch(ARTICLE_HTML);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_FETCH' });
    const result = await tool.handler(
      { url: 'https://example.com/article', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.mode).toBe('markdown');
      // Content should not have raw <script> tags.
      expect(result.output.content).not.toContain('<script>');
      expect(result.output.content).not.toContain('<style>');
      expect(result.output.cached).toBe(false);
      expect(result.output.truncated).toBe(false);
    }
  });

  test('200 HTML text mode → stripped plain text, no tags', async () => {
    mockFetch(ARTICLE_HTML);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_TEXT' });
    const result = await tool.handler(
      { url: 'https://example.com/text-page', mode: 'text', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.mode).toBe('text');
      expect(result.output.content).not.toContain('<');
      expect(result.output.content).not.toContain('alert');
    }
  });

  test('200 HTML raw mode → original HTML preserved', async () => {
    mockFetch(ARTICLE_HTML);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_RAW' });
    const result = await tool.handler(
      { url: 'https://example.com/raw-page', mode: 'raw', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.mode).toBe('raw');
      // Raw mode keeps original HTML.
      expect(result.output.content).toContain('<!DOCTYPE html>');
    }
  });

  test('<script> absent in markdown mode', async () => {
    mockFetch('<html><body><script>alert(1)</script><p>content</p></body></html>');
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_SCRIPT' });
    const result = await tool.handler(
      { url: 'https://example.com/scripted', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.content).not.toContain('alert(1)');
  });

  test('<script> absent in text mode', async () => {
    mockFetch('<html><body><script>alert(1)</script><p>content</p></body></html>');
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_SCRIPT_TEXT' });
    const result = await tool.handler(
      { url: 'https://example.com/scripted-text', mode: 'text', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.content).not.toContain('alert(1)');
  });
});

// ── §4 Output cap ─────────────────────────────────────────────────────────────

describe('SPEC-307: output cap', () => {
  test('content >50K chars → truncated with notice', async () => {
    // Generate 60K chars of plain text wrapped in minimal HTML.
    const bigText = 'x'.repeat(60_000);
    mockFetch(`<html><body><p>${bigText}</p></body></html>`);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_CAP' });
    const result = await tool.handler(
      { url: 'https://example.com/big', mode: 'text', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.truncated).toBe(true);
      expect(result.output.content.length).toBeLessThanOrEqual(50_000 + 100); // +100 for notice
      expect(result.output.content).toContain('truncated');
    }
  });

  test('content ≤50K chars → not truncated', async () => {
    const smallText = 'y'.repeat(1_000);
    mockFetch(`<html><body><p>${smallText}</p></body></html>`);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_SMALL' });
    const result = await tool.handler(
      { url: 'https://example.com/small', mode: 'text', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.truncated).toBe(false);
  });
});

// ── §5 Timeout ────────────────────────────────────────────────────────────────

describe('SPEC-307: timeout', () => {
  test('AbortError from fetch → T_TIMEOUT', async () => {
    globalThis.fetch = mock(async (_input: unknown, init?: unknown) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      // Simulate immediate abort signal.
      await new Promise<void>((_res, rej) => {
        if (signal?.aborted) { rej(Object.assign(new Error('timeout'), { name: 'AbortError' })); return; }
        signal?.addEventListener('abort', () =>
          rej(Object.assign(new Error('timeout'), { name: 'AbortError' })),
        );
        // Also reject after a tick to simulate timeout.
        setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'AbortError' })), 5);
      });
      return undefined as unknown as Response;
    }) as unknown as typeof fetch;

    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_TIMEOUT' });
    const result = await tool.handler(
      { url: 'https://example.com/slow', mode: 'markdown', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.T_TIMEOUT);
  });
});

// ── §6 Cache hit / miss / expire ─────────────────────────────────────────────

describe('SPEC-307: cache', () => {
  test('second call within TTL → cached=true, no fetch', async () => {
    let fetchCount = 0;
    mockFetch(ARTICLE_HTML);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (...args: unknown[]) => {
      fetchCount++;
      return (originalFetch as (...args: unknown[]) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;

    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_CACHE' });
    const url = 'https://example.com/cached-page';

    const first = await tool.handler({ url, mode: 'text', timeout: 15_000 }, ctx);
    expect(first.ok).toBe(true);

    // Second call — should hit cache.
    const second = await tool.handler({ url, mode: 'text', timeout: 15_000 }, ctx);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output.cached).toBe(true);

    // fetch should only have been called once.
    expect(fetchCount).toBe(1);
  });

  test('expired cache entry → re-fetches', async () => {
    const url = 'https://example.com/expired';
    const workspaceId = 'W_EXPIRE';
    const cacheDir = join(process.env['NIMBUS_WEBFETCH_CACHE_DIR'] ?? '/tmp', workspaceId);
    mkdirSync(cacheDir, { recursive: true });

    // Write an already-expired entry (ts 6 min in the past).
    const expiredOutput: WebFetchOutput = {
      url, mode: 'text', content: 'old content', truncated: false, cached: false,
    };
    const entryPath = join(cacheDir, `${urlKey(url)}.json`);
    writeFileSync(entryPath, JSON.stringify({
      key: urlKey(url),
      data: expiredOutput,
      ts: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    }), 'utf-8');

    mockFetch('<html><body><p>fresh content</p></body></html>');
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId });

    const result = await tool.handler({ url, mode: 'text', timeout: 15_000 }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.cached).toBe(false);
      expect(result.output.content).toContain('fresh content');
    }
  });

  test('cache miss returns cached=false', async () => {
    mockFetch(NON_ARTICLE_HTML);
    const tool = createWebFetchTool();
    const ctx = ctxStub({ workspaceId: 'W_MISS' });
    const result = await tool.handler(
      { url: 'https://example.com/never-cached', mode: 'text', timeout: 15_000 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.cached).toBe(false);
  });
});

// ── §7 tool metadata ──────────────────────────────────────────────────────────

describe('SPEC-307: tool metadata', () => {
  test('tool name is WebFetch', () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe('WebFetch');
  });

  test('tool is readOnly', () => {
    const tool = createWebFetchTool();
    expect(tool.readOnly).toBe(true);
  });

  test('tool is not dangerous', () => {
    const tool = createWebFetchTool();
    expect(tool.dangerous).toBe(false);
  });
});
