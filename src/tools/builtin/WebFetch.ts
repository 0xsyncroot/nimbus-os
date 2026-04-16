// WebFetch.ts — SPEC-307: GET a URL and return readable content as markdown/text/raw.

import { z } from 'zod';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NimbusError, ErrorCode, wrapError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { stripHtml } from './webSearch/sanitize.ts';
import type { Tool, ToolContext } from '../types.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_BYTES = 1 * 1024 * 1024;   // 1 MB byte cap
const MAX_CHARS = 50_000;             // 50K char output cap
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const CACHE_MAX_ENTRIES = 200;
const TRUNCATION_NOTICE = '\n\n[...content truncated at 50 000 characters...]';

// Private IP / SSRF patterns — same deny-list as SPEC-305 sanitize.ts.
const PRIVATE_IP_PATTERNS: ReadonlyArray<RegExp> = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/10\.\d+\.\d+\.\d+/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /^https?:\/\/192\.168\.\d+\.\d+/,
  /^https?:\/\/169\.254\.\d+\.\d+/,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fc/i,
  /^https?:\/\/\[fd/i,
  /^https?:\/\/metadata\./i,
  /^https?:\/\/169\.254\.169\.254/,
];

// ── Zod schemas ───────────────────────────────────────────────────────────────

export const WebFetchInputSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['markdown', 'text', 'raw']).optional().default('markdown'),
  timeout: z.number().int().min(1000).max(30_000).optional().default(15_000),
});
export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export const WebFetchOutputSchema = z.object({
  url: z.string(),
  mode: z.enum(['markdown', 'text', 'raw']),
  content: z.string(),
  truncated: z.boolean(),
  cached: z.boolean(),
  title: z.string().optional(),
});
export type WebFetchOutput = z.infer<typeof WebFetchOutputSchema>;

// ── SSRF guard ────────────────────────────────────────────────────────────────

function ssrfGuard(url: string): void {
  if (!url.startsWith('https://')) {
    throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
      reason: 'https_required',
      url,
    });
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) {
      throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
        reason: 'private_ip_blocked',
        url,
      });
    }
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  data: WebFetchOutput;
  ts: number;
}

function getCacheDir(workspaceId: string): string {
  const base =
    process.env['NIMBUS_WEBFETCH_CACHE_DIR'] ??
    join(process.env['NIMBUS_HOME'] ?? join(process.env['HOME'] ?? '/tmp', '.nimbus'), 'webfetch-cache');
  return join(base, workspaceId);
}

function urlCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function cacheGet(workspaceId: string, key: string): WebFetchOutput | null {
  const dir = getCacheDir(workspaceId);
  const filePath = join(dir, `${key}.json`);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      try { unlinkSync(filePath); } catch { /* already gone */ }
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function cacheSet(workspaceId: string, key: string, data: WebFetchOutput): void {
  const dir = getCacheDir(workspaceId);
  mkdirSync(dir, { recursive: true });

  // Evict oldest entries when at cap.
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length >= CACHE_MAX_ENTRIES) {
      const withTs: Array<{ file: string; ts: number }> = [];
      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), 'utf-8');
          const e = JSON.parse(raw) as CacheEntry;
          withTs.push({ file: f, ts: e.ts });
        } catch { /* skip corrupt */ }
      }
      withTs.sort((a, b) => a.ts - b.ts);
      for (const { file } of withTs.slice(0, withTs.length - CACHE_MAX_ENTRIES + 1)) {
        try { unlinkSync(join(dir, file)); } catch { /* skip */ }
      }
    }
  } catch { /* ignore eviction errors */ }

  const entry: CacheEntry = { key, data, ts: Date.now() };
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry), 'utf-8');
}

// ── HTML processing ───────────────────────────────────────────────────────────

function stripScriptStyle(html: string): string {
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  return out;
}

type ReadabilityArticle = { title: string; content: string };
type ReadabilityClass = new (doc: unknown) => { parse(): ReadabilityArticle | null };
type JsdomClass = new (html: string) => { window: { document: unknown } };
type TurndownClass = new () => { turndown(html: string): string };

async function extractReadability(html: string): Promise<ReadabilityArticle | null> {
  try {
    // Dynamic import — optional dependency; falls back gracefully if not installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readabilityMod = await import('@mozilla/readability' as any) as { Readability: ReadabilityClass };
    // Readability requires a real DOM; use JSDOM if available.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsdomMod = await import('jsdom' as any) as { JSDOM: JsdomClass };
    const dom = new jsdomMod.JSDOM(html);
    const reader = new readabilityMod.Readability(dom.window.document);
    return reader.parse();
  } catch {
    return null;
  }
}

async function htmlToMarkdown(html: string): Promise<string> {
  try {
    // Dynamic import — optional dependency.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('turndown' as any) as { default: TurndownClass };
    const TurndownService = mod.default;
    const td = new TurndownService();
    return td.turndown(html);
  } catch {
    return stripHtml(html);
  }
}

async function processHtml(
  html: string,
  mode: 'markdown' | 'text' | 'raw',
): Promise<{ content: string; title?: string }> {
  if (mode === 'raw') {
    return { content: html };
  }

  // Strip script/style before any processing.
  const cleaned = stripScriptStyle(html);

  if (mode === 'text') {
    return { content: stripHtml(cleaned) };
  }

  // markdown mode: try Readability first, fall back to turndown on cleaned HTML.
  const article = await extractReadability(cleaned);
  if (article?.content) {
    const md = await htmlToMarkdown(article.content);
    return { content: md, title: article.title };
  }
  // Fallback: convert cleaned HTML directly.
  const md = await htmlToMarkdown(cleaned);
  return { content: md };
}

// ── Cap utility ───────────────────────────────────────────────────────────────

function capOutput(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CHARS) + TRUNCATION_NOTICE, truncated: true };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export function createWebFetchTool(): Tool<WebFetchInput, WebFetchOutput> {
  return {
    name: 'WebFetch',
    description:
      'Fetch a single HTTPS URL and return its content as markdown (default), plain text, or raw HTML. ' +
      'SSRF-guarded. Output capped at 50 000 chars. Per-workspace 5-min cache.',
    readOnly: true,
    dangerous: false,
    inputSchema: WebFetchInputSchema,

    async handler(input: WebFetchInput, ctx: ToolContext) {
      // 1. SSRF guard — throws NimbusError on violation.
      try {
        ssrfGuard(input.url);
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }

      // 2. Cache lookup.
      const key = urlCacheKey(input.url);
      const hit = cacheGet(ctx.workspaceId, key);
      if (hit) {
        logger.debug({ url: input.url, workspaceId: ctx.workspaceId }, 'WebFetch: cache hit');
        return { ok: true, output: { ...hit, cached: true }, display: formatDisplay(hit) };
      }

      // 3. Fetch with timeout + abort.
      const ctrl = new AbortController();
      const onCancel = (): void => ctrl.abort(new Error('tool_abort'));
      ctx.onAbort(onCancel);
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), input.timeout);

      let html: string;
      try {
        const res = await fetch(input.url, {
          method: 'GET',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'nimbus-os/0.1 (+https://github.com/0xsyncroot/nimbus-os)' },
        });

        // Read body with 1 MB cap.
        const reader = res.body?.getReader();
        if (!reader) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.P_NETWORK, { reason: 'empty_body', url: input.url }),
          };
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_BYTES) {
            // Still collect up to cap so we can process partial content.
            const remaining = MAX_BYTES - (total - value.byteLength);
            if (remaining > 0) chunks.push(value.slice(0, remaining));
            break;
          }
          chunks.push(value);
        }
        reader.cancel().catch(() => undefined);
        html = new TextDecoder().decode(concatUint8(chunks));
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof NimbusError) return { ok: false, error: err };
        const isTimeout =
          err instanceof Error &&
          (err.message === 'timeout' || err.name === 'AbortError' || err.message.toLowerCase().includes('timeout'));
        if (isTimeout) {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.T_TIMEOUT, { timeoutMs: input.timeout, url: input.url }),
          };
        }
        return { ok: false, error: wrapError(err, ErrorCode.P_NETWORK, { url: input.url }) };
      } finally {
        clearTimeout(timer);
      }

      // 4. Process HTML → desired mode.
      const { content: rawContent, title } = await processHtml(html, input.mode);

      // 5. Cap output.
      const { content, truncated } = capOutput(rawContent);

      // 6. Build output (trusted="false" per META-009 T2 — callers must treat as untrusted).
      const output: WebFetchOutput = {
        url: input.url,
        mode: input.mode,
        content,
        truncated,
        cached: false,
        ...(title !== undefined ? { title } : {}),
      };

      // 7. Persist to cache.
      try {
        cacheSet(ctx.workspaceId, key, output);
      } catch (cacheErr) {
        logger.warn({ url: input.url, err: cacheErr }, 'WebFetch: cache write failed (non-fatal)');
      }

      logger.debug({ url: input.url, mode: input.mode, truncated }, 'WebFetch: fetched');
      return { ok: true, output, display: formatDisplay(output) };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

function formatDisplay(output: WebFetchOutput): string {
  const lines: string[] = [];
  lines.push(`WebFetch: ${output.url} [${output.mode}]${output.cached ? ' (cached)' : ''}`);
  if (output.title) lines.push(`Title: ${output.title}`);
  if (output.truncated) lines.push('[output truncated at 50 000 chars]');
  lines.push('');
  lines.push(output.content.slice(0, 500));
  if (output.content.length > 500) lines.push('...');
  return lines.join('\n');
}
