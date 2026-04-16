// tokens.ts — SPEC-120: token estimation utilities for context compaction.
// Pure TS: no Bun APIs, no LLM calls. Used by compact.ts, microCompact.ts, slidingWindow.ts.

import type { CanonicalBlock, CanonicalMessage } from '../ir/types.ts';

/** Flat token estimate for an image block (covers most vision models). */
export const IMAGE_TOKEN_ESTIMATE = 2000;

/** Tokens reserved for model output ceiling. */
export const MAX_OUTPUT_RESERVE = 20_000;

/** Compact trigger threshold: fire when usage exceeds this fraction of effective window. */
export const COMPACT_THRESHOLD = 0.8;

/** Per-model context window sizes (tokens). Defaults to 128K for unknown models. */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  'claude-opus-4': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4': 200_000,
  'claude-opus-3-5': 200_000,
  'claude-sonnet-3-5': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'o1': 128_000,
  'o3': 200_000,
  'gemini-1.5-pro': 1_000_000,
  'gemini-1.5-flash': 1_000_000,
};

const DEFAULT_CONTEXT_SIZE = 128_000;

/**
 * Rough token count for a string. Uses ~4 chars/token with a 4/3 conservative padding.
 * Fast (<2ms for 100K chars), no external deps.
 */
export function roughTokenCount(text: string): number {
  if (text.length === 0) return 0;
  const base = text.length / 4;
  return Math.ceil(base * (4 / 3));
}

/** Estimate tokens for a single CanonicalBlock. */
function blockTokens(block: CanonicalBlock): number {
  switch (block.type) {
    case 'text':
      return roughTokenCount(block.text);
    case 'image':
      return IMAGE_TOKEN_ESTIMATE;
    case 'tool_use':
      return roughTokenCount(block.name) + roughTokenCount(JSON.stringify(block.input));
    case 'tool_result': {
      const content = block.content;
      if (typeof content === 'string') return roughTokenCount(content);
      return content.reduce((sum, b) => sum + blockTokens(b), 0);
    }
    case 'thinking':
      return roughTokenCount(block.text);
  }
}

/** Estimate total tokens for a CanonicalMessage. */
export function messageTokens(msg: CanonicalMessage): number {
  const content = msg.content;
  if (typeof content === 'string') return roughTokenCount(content);
  return content.reduce((sum, b) => sum + blockTokens(b), 0);
}

/** Estimate total tokens for a message array. */
export function messagesTokenCount(messages: CanonicalMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** Look up context window for model. Prefix-matches (e.g., "claude-sonnet-4-5-..." → claude-sonnet-4-5). */
export function contextWindowFor(model: string): number {
  // Exact match first
  if (model in MODEL_CONTEXT_SIZES) return MODEL_CONTEXT_SIZES[model]!;
  // Prefix match
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_SIZES)) {
    if (model.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_SIZE;
}

/**
 * Effective context budget: contextWindow minus a reserved output headroom.
 * maxOutput is capped at MAX_OUTPUT_RESERVE to prevent over-reservation.
 */
export function effectiveWindow(model: string, maxOutput: number = MAX_OUTPUT_RESERVE): number {
  const window = contextWindowFor(model);
  const reserve = Math.min(maxOutput, MAX_OUTPUT_RESERVE);
  return window - reserve;
}

/**
 * Returns true if the messages exceed the auto-compact trigger threshold
 * (COMPACT_THRESHOLD of effectiveWindow).
 */
export function shouldAutoCompact(messages: CanonicalMessage[], model: string, maxOutput?: number): boolean {
  const budget = effectiveWindow(model, maxOutput);
  const used = messagesTokenCount(messages);
  return used > budget * COMPACT_THRESHOLD;
}
