// SPEC-903 — orchestrator: fetch → cache → fallback. Used by wizard + future CLI.
import { logger } from '../observability/logger.ts';
import { anthropicFetcher } from './fetchers/anthropic.ts';
import { openaiCompatFetcher } from './fetchers/openaiCompat.ts';
import { ollamaFetcher } from './fetchers/ollama.ts';
import {
  curatedFallback,
  enrich,
  readCache,
  writeCache,
} from './store.ts';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  type FetchResult,
  type ModelDescriptor,
  type ProviderCatalogFetcher,
} from './types.ts';

export type DiscoverProvider = 'anthropic' | 'openai-compat' | 'ollama';

export interface DiscoverInput {
  provider: DiscoverProvider;
  /** provider name used for cache key + display (e.g. 'anthropic', 'groq', 'openai') */
  providerTag: string;
  baseUrl: string;
  apiKey: string | null;
  timeoutMs?: number;
  refresh?: boolean;
}

export interface DiscoverResult {
  models: ModelDescriptor[];
  source: 'live' | 'cache' | 'curated' | 'empty';
  staleBanner: boolean;
  reason?: string;
}

function selectFetcher(p: DiscoverProvider): ProviderCatalogFetcher {
  if (p === 'anthropic') return anthropicFetcher;
  if (p === 'ollama') return ollamaFetcher;
  return openaiCompatFetcher;
}

export async function discoverModels(input: DiscoverInput): Promise<DiscoverResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const cacheKey = input.providerTag;

  if (!input.refresh) {
    const cached = await readCache(cacheKey, input.baseUrl);
    if (cached.hit && !cached.stale && cached.models) {
      return { models: enrich(cached.models), source: 'cache', staleBanner: false };
    }
  }

  const fetcher = selectFetcher(input.provider);
  let result: FetchResult;
  try {
    result = await fetcher.fetch(input.baseUrl, input.apiKey, { timeoutMs });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'catalog_fetch_exception');
    result = { ok: false, reason: 'network', detail: 'exception' };
  }

  if (result.ok && result.models.length > 0) {
    try {
      await writeCache(cacheKey, input.baseUrl, result.models);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'catalog_cache_write_failed');
    }
    return { models: enrich(result.models), source: 'live', staleBanner: false };
  }

  // fetch failed → try stale cache, then curated.
  const stale = await readCache(cacheKey, input.baseUrl);
  if (stale.hit && stale.models && stale.models.length > 0) {
    return {
      models: enrich(stale.models),
      source: 'cache',
      staleBanner: true,
      ...(result.ok ? {} : { reason: result.reason }),
    };
  }

  const curated = curatedFallback(cacheKey);
  if (curated.length > 0) {
    return {
      models: enrich(curated),
      source: 'curated',
      staleBanner: true,
      ...(result.ok ? {} : { reason: result.reason }),
    };
  }

  return {
    models: [],
    source: 'empty',
    staleBanner: true,
    ...(result.ok ? {} : { reason: result.reason }),
  };
}
