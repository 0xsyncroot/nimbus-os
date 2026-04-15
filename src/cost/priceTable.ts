// priceTable.ts — SPEC-701 T2: 2026 USD per million tokens + fuzzy class match.

import { logger } from '../observability/logger.ts';
import type { ModelClass, Provider, TokenUsage } from './types.ts';

export interface Price {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  class: ModelClass;
}

type ProviderTable = Readonly<Record<string, Price>>;

export const PRICE_TABLE: Readonly<Record<Provider, ProviderTable>> = {
  anthropic: {
    'opus-4-6':   { in: 15,   out: 75,   cacheRead: 1.5,   cacheWrite: 18.75, class: 'flagship'  },
    'sonnet-4-5': { in: 3,    out: 15,   cacheRead: 0.3,   cacheWrite: 3.75,  class: 'workhorse' },
    'sonnet-4-6': { in: 3,    out: 15,   cacheRead: 0.3,   cacheWrite: 3.75,  class: 'workhorse' },
    'haiku-4-5':  { in: 1,    out: 5,    cacheRead: 0.1,   cacheWrite: 1.25,  class: 'budget'    },
  },
  openai: {
    'gpt-4o':      { in: 2.5,  out: 10,   cacheRead: 1.25,  cacheWrite: 0,     class: 'workhorse' },
    'gpt-4o-mini': { in: 0.15, out: 0.60, cacheRead: 0.075, cacheWrite: 0,     class: 'budget'    },
    'o1':          { in: 15,   out: 60,   cacheRead: 7.5,   cacheWrite: 0,     class: 'reasoning' },
  },
  groq: {
    'llama-3.3-70b': { in: 0.59, out: 0.79, cacheRead: 0, cacheWrite: 0, class: 'budget' },
  },
  deepseek: {
    'v3': { in: 0.27, out: 1.10, cacheRead: 0.07, cacheWrite: 0, class: 'budget' },
  },
  ollama: {
    '*': { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, class: 'local' },
  },
};

const UNKNOWN_PRICE: Price = {
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  class: 'workhorse',
};

// Warn-once memory for unknown (provider, model) pairs.
const warnedUnknown = new Set<string>();

/**
 * Normalize common model aliases (anthropic long form → short key, etc.).
 */
function normalizeAnthropic(model: string): string {
  // claude-opus-4-6-20250101 → opus-4-6
  // claude-3-7-sonnet-20250101 → sonnet-4-5 (bridge old naming to closest 2026 tier)
  const m = model.toLowerCase();
  if (m.includes('opus-4-6') || m.includes('opus-4.6')) return 'opus-4-6';
  if (m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return 'sonnet-4-6';
  if (m.includes('sonnet-4-5') || m.includes('sonnet-4.5')) return 'sonnet-4-5';
  if (m.includes('haiku-4-5') || m.includes('haiku-4.5')) return 'haiku-4-5';
  if (m.includes('sonnet')) return 'sonnet-4-6';
  if (m.includes('opus')) return 'opus-4-6';
  if (m.includes('haiku')) return 'haiku-4-5';
  return model;
}

function normalizeOpenAi(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (m.startsWith('gpt-4o')) return 'gpt-4o';
  if (m.startsWith('o1')) return 'o1';
  return model;
}

function normalize(provider: Provider, model: string): string {
  switch (provider) {
    case 'anthropic':
      return normalizeAnthropic(model);
    case 'openai':
      return normalizeOpenAi(model);
    default:
      return model;
  }
}

export function lookupPrice(provider: string, model: string): Price {
  const table = PRICE_TABLE[provider as Provider];
  if (!table) {
    warnUnknown(provider, model);
    return UNKNOWN_PRICE;
  }
  if (provider === 'ollama') {
    return table['*']!;
  }
  const normalized = normalize(provider as Provider, model);
  const exact = table[normalized];
  if (exact) return exact;
  // Fuzzy: substring match on keys.
  for (const [k, v] of Object.entries(table)) {
    if (k !== '*' && normalized.includes(k)) return v;
  }
  warnUnknown(provider, model);
  return UNKNOWN_PRICE;
}

export function resolveClass(provider: string, model: string): ModelClass {
  return lookupPrice(provider, model).class;
}

function warnUnknown(provider: string, model: string): void {
  const key = `${provider}::${model}`;
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  logger.warn({ provider, model }, 'cost: unknown model — priced at $0');
}

export interface CostBreakdown {
  costUsd: number;
  costSavedUsd: number;
}

/**
 * Compute cost from token usage. All prices are USD per 1M tokens.
 * `costSavedUsd` = savings from cache-read (what full input-rate would have charged)
 * minus what we actually paid at the cache-read rate.
 */
export function computeCost(
  usage: TokenUsage,
  provider: string,
  model: string,
): CostBreakdown {
  const p = lookupPrice(provider, model);
  const MIL = 1_000_000;
  const inputCost = (usage.inputTokens / MIL) * p.in;
  const outputCost = (usage.outputTokens / MIL) * p.out;
  const cacheReadCost = (usage.cacheReadTokens / MIL) * p.cacheRead;
  const cacheWriteCost = (usage.cacheWriteTokens / MIL) * p.cacheWrite;
  const reasoningCost = (usage.reasoningTokens / MIL) * p.out;
  const costUsd =
    inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost;

  const baseRateForCached = (usage.cacheReadTokens / MIL) * p.in;
  const costSavedUsd = Math.max(0, baseRateForCached - cacheReadCost);

  return {
    costUsd: round6(costUsd),
    costSavedUsd: round6(costSavedUsd),
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// Testing hook — reset warn-once state.
export function __resetPriceWarnings(): void {
  warnedUnknown.clear();
}
