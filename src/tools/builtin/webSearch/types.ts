// webSearch/types.ts — SPEC-305 T1: Zod input/output schemas + types.

import { z } from 'zod';

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(20).optional().default(5),
  dateRange: z.enum(['day', 'week', 'month', 'year']).optional(),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  publishedDate: z.string().optional(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchOutputSchema = z.object({
  results: z.array(WebSearchResultSchema),
  provider: z.string(),
  query: z.string(),
});
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

export type SearchProvider = 'tavily' | 'brave' | 'exa';

export interface SearchFetcherResult {
  results: WebSearchResult[];
  provider: SearchProvider;
}

export type FetchSearchOutcome =
  | { ok: true; data: SearchFetcherResult }
  | { ok: false; reason: 'auth' | 'timeout' | 'network' | 'parse' | 'http'; detail?: string };

export interface SearchFetcherOpts {
  timeoutMs: number;
  maxBytes: number;
}

export interface SearchFetcher {
  readonly provider: SearchProvider;
  fetch(
    query: string,
    maxResults: number,
    dateRange: WebSearchInput['dateRange'],
    apiKey: string,
    opts: SearchFetcherOpts,
  ): Promise<FetchSearchOutcome>;
}

export const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
export const MAX_SEARCH_RESPONSE_BYTES = 500 * 1024;
