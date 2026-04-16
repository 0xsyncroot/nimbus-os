// webSearch/brave.ts — SPEC-305 T3: Brave Search fetcher via raw HTTP.

import { sanitizeSnippet, validateResultUrl } from './sanitize.ts';
import { logger } from '../../../observability/logger.ts';
import type {
  SearchFetcher,
  SearchFetcherOpts,
  FetchSearchOutcome,
  WebSearchInput,
  WebSearchResult,
} from './types.ts';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

const DATE_RANGE_MAP: Record<NonNullable<WebSearchInput['dateRange']>, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export const braveFetcher: SearchFetcher = {
  provider: 'brave',

  async fetch(
    query: string,
    maxResults: number,
    dateRange: WebSearchInput['dateRange'],
    apiKey: string,
    opts: SearchFetcherOpts,
  ): Promise<FetchSearchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });
    if (dateRange) {
      params.set('freshness', DATE_RANGE_MAP[dateRange]);
    }

    try {
      const res = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'auth', detail: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { ok: false, reason: 'http', detail: `HTTP ${res.status}` };
      }

      const contentLength = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > opts.maxBytes) {
        return { ok: false, reason: 'http', detail: 'response_too_large' };
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, reason: 'parse', detail: 'invalid_json' };
      }

      const parsed = json as BraveResponse;
      const rawItems = Array.isArray(parsed?.web?.results) ? parsed.web.results : [];
      const results: WebSearchResult[] = [];

      for (const item of rawItems) {
        const url = String(item.url ?? '');
        const title = String(item.title ?? '');
        const rawSnippet = String(item.description ?? '');
        const publishedDate = item.age ? String(item.age) : undefined;

        try {
          validateResultUrl(url);
        } catch {
          logger.warn({ url }, 'brave: skipping non-HTTPS or private-IP result');
          continue;
        }

        const { text: snippet } = sanitizeSnippet(rawSnippet);
        results.push({ title, url, snippet, ...(publishedDate ? { publishedDate } : {}) });
      }

      return { ok: true, data: { results, provider: 'brave' } };
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
  },
};
