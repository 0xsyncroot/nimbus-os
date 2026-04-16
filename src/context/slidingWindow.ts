// slidingWindow.ts — SPEC-120: sliding window fallback for context compaction.
// Keeps system prompt + last N messages that fit within the token budget.
// Used when fullCompact is too expensive or provider has no summarisation capability.
// Pure TS, no LLM calls, <1ms.

import type { CanonicalMessage } from '../ir/types.ts';
import { messageTokens } from './tokens.ts';
import { logger } from '../observability/logger.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SlidingWindowResult {
  messages: CanonicalMessage[];
  droppedCount: number;
  retainedTokens: number;
}

// ---------------------------------------------------------------------------
// Main slidingWindow
// ---------------------------------------------------------------------------

/**
 * Sliding window fallback: keep the system prompt (if any) + the most-recent
 * messages that fit within `budget` tokens.
 *
 * Algorithm:
 * 1. Separate system messages from conversation messages.
 * 2. Calculate tokens used by system messages.
 * 3. Walk conversation messages from newest to oldest, accumulating tokens.
 * 4. Stop when budget would be exceeded.
 * 5. Return system messages + kept conversation slice.
 *
 * Returns a new array — does not mutate input.
 */
export function slidingWindow(
  messages: CanonicalMessage[],
  budget: number,
): SlidingWindowResult {
  if (messages.length === 0) {
    return { messages: [], droppedCount: 0, retainedTokens: 0 };
  }

  // Separate system from conversation messages
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const conversationMsgs = messages.filter((m) => m.role !== 'system');

  // Tokens consumed by system messages
  const systemTokens = systemMsgs.reduce((sum, m) => sum + messageTokens(m), 0);
  let remaining = budget - systemTokens;

  if (remaining <= 0) {
    // System prompt alone exceeds budget — keep only system messages
    logger.warn({ systemTokens, budget }, 'slidingWindow: system prompt exceeds budget; dropping all conversation');
    return {
      messages: systemMsgs,
      droppedCount: conversationMsgs.length,
      retainedTokens: systemTokens,
    };
  }

  // Walk newest-first to fill remaining budget
  const kept: CanonicalMessage[] = [];
  for (let i = conversationMsgs.length - 1; i >= 0; i--) {
    const msg = conversationMsgs[i]!;
    const tokens = messageTokens(msg);
    if (tokens > remaining) break;
    remaining -= tokens;
    kept.unshift(msg);
  }

  const droppedCount = conversationMsgs.length - kept.length;
  const retainedTokens = budget - remaining;

  if (droppedCount > 0) {
    logger.info(
      { droppedCount, retainedTokens, budget },
      'slidingWindow: dropped old messages to fit budget',
    );
  }

  return {
    messages: [...systemMsgs, ...kept],
    droppedCount,
    retainedTokens,
  };
}

/**
 * Calculate the maximum number of messages that can be kept within budget,
 * scanning from the tail of the array.
 * Useful for pre-checks without building the full result.
 */
export function slidingWindowCapacity(
  messages: CanonicalMessage[],
  budget: number,
): number {
  let remaining = budget;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = messageTokens(messages[i]!);
    if (tokens > remaining) break;
    remaining -= tokens;
    count++;
  }
  return count;
}
