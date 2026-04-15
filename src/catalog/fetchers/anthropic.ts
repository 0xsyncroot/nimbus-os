// SPEC-903 T2 — Anthropic /v1/models fetcher. Filters to chat-capable entries.
import { boundedFetchJSON } from '../fetchHelper.ts';
import {
  type FetchResult,
  type FetcherOpts,
  type ModelDescriptor,
  type ProviderCatalogFetcher,
} from '../types.ts';

interface AnthropicModelsResponse {
  data?: Array<{
    id?: string;
    display_name?: string;
    type?: string;
  }>;
}

function isAnthropicResponse(v: unknown): v is AnthropicModelsResponse {
  return typeof v === 'object' && v !== null && 'data' in (v as Record<string, unknown>);
}

export const anthropicFetcher: ProviderCatalogFetcher = {
  async fetch(
    baseUrl: string,
    apiKey: string | null,
    opts: FetcherOpts,
  ): Promise<FetchResult> {
    if (!apiKey) return { ok: false, reason: 'auth', detail: 'missing_key' };
    const url = `${trimSlash(baseUrl)}/v1/models`;
    const outcome = await boundedFetchJSON(
      url,
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
      },
      opts,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
    if (!isAnthropicResponse(outcome.raw.json)) {
      return { ok: false, reason: 'parse', detail: 'missing_data_field' };
    }
    const now = Date.now();
    const models: ModelDescriptor[] = [];
    for (const m of outcome.raw.json.data ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      // Anthropic's public /v1/models currently returns only chat-capable models (type === 'model').
      // Guard defensively — skip anything explicitly non-'model'.
      if (typeof m.type === 'string' && m.type !== 'model') continue;
      models.push({
        id: m.id,
        provider: 'anthropic',
        ...(typeof m.display_name === 'string' ? { displayName: m.display_name } : {}),
        source: 'live',
        fetchedAt: now,
      });
    }
    return { ok: true, models };
  },
};

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
