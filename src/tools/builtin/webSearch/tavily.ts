// webSearch/tavily.ts — SPEC-305 T2: Tavily search fetcher via raw HTTP (matches @tavily/core API).

import { sanitizeSnippet, validateResultUrl } from './sanitize.ts';
import { logger } from '../../../observability/logger.ts';
import type {
  SearchFetcher,
  SearchFetcherOpts,
  FetchSearchOutcome,
  WebSearchInput,
  WebSearchResult,
} from './types.ts';

const TAVILY_API_URL = 'https://api.tavily.com/search';

const DATE_RANGE_DAYS: Record<NonNullable<WebSearchInput['dateRange']>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

interface TavilyResultItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: TavilyResultItem[];
  query?: string;
}

export const tavilyFetcher: SearchFetcher = {
  provider: 'tavily',

  async fetch(
    query: string,
    maxResults: number,
    dateRange: WebSearchInput['dateRange'],
    apiKey: string,
    opts: SearchFetcherOpts,
  ): Promise<FetchSearchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const body: Record<string, unknown> = {
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    };
    if (dateRange) {
      body['days'] = DATE_RANGE_DAYS[dateRange];
    }

    try {
      const res = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Strip auth from error payloads by NOT including it in cached/logged responses.
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
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

      const parsed = json as TavilyResponse;
      const rawItems = Array.isArray(parsed?.results) ? parsed.results : [];
      const results: WebSearchResult[] = [];

      for (const item of rawItems) {
        const url = String(item.url ?? '');
        const title = String(item.title ?? '');
        const rawSnippet = String(item.content ?? item.raw_content ?? '');
        const publishedDate = item.published_date ? String(item.published_date) : undefined;

        try {
          validateResultUrl(url);
        } catch {
          logger.warn({ url }, 'tavily: skipping non-HTTPS or private-IP result');
          continue;
        }

        const { text: snippet } = sanitizeSnippet(rawSnippet);
        results.push({ title, url, snippet, ...(publishedDate ? { publishedDate } : {}) });
      }

      return { ok: true, data: { results, provider: 'tavily' } };
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
