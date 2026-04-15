// SPEC-903 T4 — Ollama /api/tags fetcher. Keyless localhost endpoint.
import { boundedFetchJSON } from '../fetchHelper.ts';
import {
  type FetchResult,
  type FetcherOpts,
  type ModelDescriptor,
  type ProviderCatalogFetcher,
} from '../types.ts';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    details?: { parameter_size?: string; family?: string };
  }>;
}

function isOllamaResponse(v: unknown): v is OllamaTagsResponse {
  return typeof v === 'object' && v !== null && 'models' in (v as Record<string, unknown>);
}

export const ollamaFetcher: ProviderCatalogFetcher = {
  async fetch(
    baseUrl: string,
    _apiKey: string | null,
    opts: FetcherOpts,
  ): Promise<FetchResult> {
    // Spec: Ollama uses `{baseUrl}/api/tags`. If user configured baseUrl as `.../v1`,
    // strip the `/v1` suffix to reach the root HTTP API.
    const root = normalizeOllamaBase(baseUrl);
    const url = `${root}/api/tags`;
    const outcome = await boundedFetchJSON(
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      opts,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
    if (!isOllamaResponse(outcome.raw.json)) {
      return { ok: false, reason: 'parse', detail: 'missing_models_field' };
    }
    const now = Date.now();
    const models: ModelDescriptor[] = [];
    for (const m of outcome.raw.json.models ?? []) {
      const id = m?.name ?? m?.model;
      if (typeof id !== 'string' || id.length === 0) continue;
      models.push({
        id,
        provider: 'ollama',
        source: 'live',
        fetchedAt: now,
      });
    }
    return { ok: true, models };
  },
};

export function normalizeOllamaBase(baseUrl: string): string {
  let s = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (s.endsWith('/v1')) s = s.slice(0, -3);
  return s;
}
