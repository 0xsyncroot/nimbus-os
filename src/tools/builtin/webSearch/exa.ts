// webSearch/exa.ts — SPEC-305 T4: Exa Search fetcher via raw HTTP (matches exa-js API).

import { sanitizeSnippet, validateResultUrl } from './sanitize.ts';
import { logger } from '../../../observability/logger.ts';
import type {
  SearchFetcher,
  SearchFetcherOpts,
  FetchSearchOutcome,
  WebSearchInput,
  WebSearchResult,
} from './types.ts';

const EXA_API_URL = 'https://api.exa.ai/search';

// Exa uses start_crawl_date ISO strings for date filtering.
function dateRangeToStartDate(dateRange: NonNullable<WebSearchInput['dateRange']>): string {
  const daysAgo: Record<NonNullable<WebSearchInput['dateRange']>, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const d = new Date(Date.now() - daysAgo[dateRange] * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

interface ExaResultItem {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  publishedDate?: unknown;
}

interface ExaResponse {
  results?: ExaResultItem[];
}

export const exaFetcher: SearchFetcher = {
  provider: 'exa',

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
      numResults: maxResults,
      type: 'neural',
      contents: {
        text: { maxCharacters: 500 },
      },
    };
    if (dateRange) {
      body['startCrawlDate'] = dateRangeToStartDate(dateRange);
    }

    try {
      const res = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
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

      const parsed = json as ExaResponse;
      const rawItems = Array.isArray(parsed?.results) ? parsed.results : [];
      const results: WebSearchResult[] = [];

      for (const item of rawItems) {
        const url = String(item.url ?? '');
        const title = String(item.title ?? '');
        const rawSnippet = String(item.text ?? '');
        const publishedDate = item.publishedDate ? String(item.publishedDate) : undefined;

        try {
          validateResultUrl(url);
        } catch {
          logger.warn({ url }, 'exa: skipping non-HTTPS or private-IP result');
          continue;
        }

        const { text: snippet } = sanitizeSnippet(rawSnippet);
        results.push({ title, url, snippet, ...(publishedDate ? { publishedDate } : {}) });
      }

      return { ok: true, data: { results, provider: 'exa' } };
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
