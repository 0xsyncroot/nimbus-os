// WebSearch.ts — SPEC-305 T7: Main WebSearch tool with fallback chain + cost event emission.

import { z } from 'zod';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { getBest } from '../../platform/secrets/index.ts';
import { tavilyFetcher } from './webSearch/tavily.ts';
import { braveFetcher } from './webSearch/brave.ts';
import { exaFetcher } from './webSearch/exa.ts';
import { cacheKey, cacheGet, cacheSet } from './webSearch/cache.ts';
import {
  WebSearchInputSchema,
  WebSearchOutputSchema,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESPONSE_BYTES,
} from './webSearch/types.ts';
import type {
  WebSearchInput,
  WebSearchOutput,
  SearchFetcher,
  SearchProvider,
} from './webSearch/types.ts';
import type { Tool, ToolContext } from '../types.ts';

export { WebSearchInputSchema, WebSearchOutputSchema };
export type { WebSearchInput, WebSearchOutput };

// Approximate search costs per 1K queries (USD).
const ESTIMATED_COST_PER_QUERY: Record<SearchProvider, number> = {
  tavily: 0.003,
  brave: 0.005,
  exa: 0.007,
};

const SECRET_SERVICE = 'nimbus-os';
const KEY_NAMES: Record<SearchProvider, string> = {
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
};

// Fallback order: tavily → brave → exa (by default).
const FETCHER_ORDER: SearchFetcher[] = [tavilyFetcher, braveFetcher, exaFetcher];

async function resolveApiKey(provider: SearchProvider): Promise<string | null> {
  // 1. Environment variable takes priority.
  const envKey = process.env[KEY_NAMES[provider]];
  if (envKey) return envKey;

  // 2. Vault / platform secret store.
  try {
    const store = await getBest();
    const val = await store.get(SECRET_SERVICE, KEY_NAMES[provider]);
    if (val) return val;
  } catch {
    // Vault unavailable or key not set — fall through.
  }

  return null;
}

function emitCostEvent(provider: SearchProvider, ctx: ToolContext): void {
  // CostEvent emission per SPEC-701. The full ledger machinery may not exist yet in all
  // environments, so we log at debug level and emit as a structured event on the logger.
  const estimatedCost = ESTIMATED_COST_PER_QUERY[provider];
  ctx.logger.debug(
    {
      kind: 'web_search',
      provider,
      estimatedCost,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolUseId: ctx.toolUseId,
    },
    'WebSearch cost event',
  );
}

export function createWebSearchTool(): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: 'WebSearch',
    description:
      'Perform a live web search. Backends: Tavily (default), Brave, Exa. BYOK via vault. ' +
      'Results are HTML-stripped and injection-checked.',
    readOnly: true,
    dangerous: false,
    inputSchema: WebSearchInputSchema,

    async handler(input: WebSearchInput, ctx: ToolContext) {
      const opts = {
        timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
        maxBytes: MAX_SEARCH_RESPONSE_BYTES,
      };

      // Try each fetcher in order, skipping ones without a key.
      let lastReason: string | undefined;
      for (const fetcher of FETCHER_ORDER) {
        const apiKey = await resolveApiKey(fetcher.provider);
        if (!apiKey) {
          logger.debug({ provider: fetcher.provider }, 'WebSearch: no API key, skipping provider');
          continue;
        }

        // Cache lookup.
        const key = cacheKey(fetcher.provider, input.query, input.maxResults, input.dateRange);
        const cached = cacheGet(key);
        if (cached) {
          logger.debug({ provider: fetcher.provider, key }, 'WebSearch: cache hit');
          emitCostEvent(fetcher.provider, ctx);
          return { ok: true, output: cached, display: formatDisplay(cached) };
        }

        // Fetch.
        const result = await fetcher.fetch(
          input.query,
          input.maxResults,
          input.dateRange,
          apiKey,
          opts,
        );

        if (result.ok) {
          const output: WebSearchOutput = {
            results: result.data.results,
            provider: result.data.provider,
            query: input.query,
          };
          // Validate output schema.
          const parsed = WebSearchOutputSchema.safeParse(output);
          if (!parsed.success) {
            logger.warn({ provider: fetcher.provider }, 'WebSearch: output schema validation failed, trying next provider');
            lastReason = 'schema_invalid';
            continue;
          }
          cacheSet(key, parsed.data);
          emitCostEvent(fetcher.provider, ctx);
          return { ok: true, output: parsed.data, display: formatDisplay(parsed.data) };
        }

        logger.warn(
          { provider: fetcher.provider, reason: result.reason, detail: result.detail },
          'WebSearch: provider failed, trying next',
        );
        lastReason = result.reason;

        if (result.reason === 'auth') {
          // Auth failures on a provider are definitive — skip it, try next.
          continue;
        }
        // For timeout/network we also fall through to next provider.
      }

      // All providers exhausted.
      if (lastReason === 'auth') {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.P_AUTH, {
            reason: 'all_search_providers_auth_failed',
          }),
        };
      }
      if (lastReason === 'timeout') {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.T_TIMEOUT, {
            reason: 'all_search_providers_timed_out',
          }),
        };
      }

      const hasAnyKey = (
        await Promise.all(FETCHER_ORDER.map((f) => resolveApiKey(f.provider)))
      ).some(Boolean);

      if (!hasAnyKey) {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'no_search_api_key',
            hint: 'Set TAVILY_API_KEY, BRAVE_API_KEY, or EXA_API_KEY',
          }),
        };
      }

      return {
        ok: false,
        error: new NimbusError(ErrorCode.P_NETWORK, {
          reason: 'all_search_providers_failed',
          lastReason,
        }),
      };
    },
  };
}

function formatDisplay(output: WebSearchOutput): string {
  const lines: string[] = [`Search: "${output.query}" via ${output.provider}`, ''];
  for (const r of output.results) {
    lines.push(`• ${r.title}`);
    lines.push(`  ${r.url}`);
    if (r.snippet) lines.push(`  ${r.snippet.slice(0, 200)}`);
    lines.push('');
  }
  return lines.join('\n');
}

