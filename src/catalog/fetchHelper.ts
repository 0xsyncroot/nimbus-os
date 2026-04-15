// Shared fetch helper — timeout, byte cap, auth classification (SPEC-903 §3).
import { MAX_RESPONSE_BYTES } from './types.ts';
import type { FetchResult, FetcherOpts } from './types.ts';

export interface RawFetch {
  json: unknown;
  status: number;
}

export type RawFetchOutcome =
  | { ok: true; raw: RawFetch }
  | { ok: false; reason: FetchFailReason; detail?: string };

export type FetchFailReason = Extract<FetchResult, { ok: false }>['reason'];

export async function boundedFetchJSON(
  url: string,
  init: RequestInit,
  opts: FetcherOpts,
): Promise<RawFetchOutcome> {
  const limit = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };
    }
    const contentLength = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      return { ok: false, reason: 'too_large', detail: `content-length ${contentLength}` };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, reason: 'parse', detail: 'no_body' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return { ok: false, reason: 'too_large', detail: `stream_exceeded ${total}` };
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const text = new TextDecoder('utf-8').decode(buf);
    try {
      const json = JSON.parse(text) as unknown;
      return { ok: true, raw: { json, status: res.status } };
    } catch (err) {
      return { ok: false, reason: 'parse', detail: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return {
      ok: false,
      reason: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
