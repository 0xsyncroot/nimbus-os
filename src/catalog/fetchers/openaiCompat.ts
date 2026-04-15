// SPEC-903 T3 — OpenAI-compat universal /v1/models fetcher with regex allowlist.
import { boundedFetchJSON } from '../fetchHelper.ts';
import {
  type FetchResult,
  type FetcherOpts,
  type ModelDescriptor,
  type ProviderCatalogFetcher,
} from '../types.ts';

interface OpenAIModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

function isOpenAIResponse(v: unknown): v is OpenAIModelsResponse {
  return typeof v === 'object' && v !== null && 'data' in (v as Record<string, unknown>);
}

// Client-side allowlist — the `/v1/models` endpoint returns embeddings/TTS/whisper/image
// entries that are not chat-capable. Server has no flag, so we gate by canonical chat prefixes.
export const OPENAI_COMPAT_CHAT_RE = /^(gpt-[45]|o[1-9]|claude|llama|deepseek|mixtral|qwen|gemma|mistral|phi|command-r|yi|glm|kimi|sonnet|haiku|opus)/i;

export const openaiCompatFetcher: ProviderCatalogFetcher = {
  async fetch(
    baseUrl: string,
    apiKey: string | null,
    opts: FetcherOpts,
  ): Promise<FetchResult> {
    const url = `${trimSlash(baseUrl)}/models`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const outcome = await boundedFetchJSON(url, { method: 'GET', headers }, opts);
    if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
    if (!isOpenAIResponse(outcome.raw.json)) {
      return { ok: false, reason: 'parse', detail: 'missing_data_field' };
    }
    const now = Date.now();
    const models: ModelDescriptor[] = [];
    for (const m of outcome.raw.json.data ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      if (!OPENAI_COMPAT_CHAT_RE.test(m.id)) continue;
      models.push({
        id: m.id,
        provider: 'openai-compat',
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
