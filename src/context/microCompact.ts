// microCompact.ts — SPEC-120: per-turn micro compaction.
// Surgically clears stale tool_result blocks BEFORE the API call.
// No LLM call — pure message mutation (<10ms).

import type { CanonicalBlock, CanonicalMessage } from '../ir/types.ts';
import { messageTokens, roughTokenCount } from './tokens.ts';
import { logger } from '../observability/logger.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tools whose results can be cleared when stale. */
export const COMPACTABLE_TOOLS = new Set([
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Edit',
  'Write',
]);

/**
 * Number of most-recent tool_result blocks to preserve intact (recency buffer).
 * Older tool results beyond this count are candidates for clearing.
 */
export const MICRO_COMPACT_RECENCY = 3;

/** Provider kind — determines mutation strategy. */
export type ProviderKind = 'anthropic' | 'openai-compat';

/** Sentinel text replacing cleared tool result content. */
export function clearSentinel(savedTokens: number): string {
  return `[result cleared — ${savedTokens} tokens saved]`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicroCompactStats {
  clearedCount: number;
  savedTokens: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect indices of tool_result blocks across all messages, associated with
 * tool names resolved from the preceding tool_use blocks.
 */
interface ToolResultLocation {
  msgIndex: number;
  blockIndex: number;
  toolName: string;
  tokenCount: number;
  toolUseId: string;
}

function collectToolResults(messages: CanonicalMessage[]): ToolResultLocation[] {
  // Build a map from toolUseId → tool name by scanning tool_use blocks
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  const results: ToolResultLocation[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (typeof msg.content === 'string') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]!;
      if (block.type === 'tool_result') {
        const toolName = toolNameById.get(block.toolUseId) ?? '';
        const tokenCount = estimateToolResultTokens(block);
        results.push({ msgIndex: mi, blockIndex: bi, toolName, tokenCount, toolUseId: block.toolUseId });
      }
    }
  }
  return results;
}

function estimateToolResultTokens(block: Extract<CanonicalBlock, { type: 'tool_result' }>): number {
  if (typeof block.content === 'string') return roughTokenCount(block.content);
  return block.content.reduce((sum, b) => {
    if (b.type === 'text') return sum + roughTokenCount(b.text);
    return sum;
  }, 0);
}

function clearToolResultBlock(
  block: Extract<CanonicalBlock, { type: 'tool_result' }>,
  savedTokens: number,
): Extract<CanonicalBlock, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    toolUseId: block.toolUseId,
    content: clearSentinel(savedTokens),
    isError: block.isError,
  };
}

// ---------------------------------------------------------------------------
// Main microCompact
// ---------------------------------------------------------------------------

/**
 * Per-turn micro compaction: scans messages for old tool_result blocks from
 * compactable tools, replaces content with a sentinel string.
 *
 * - Keeps the most recent MICRO_COMPACT_RECENCY tool results intact.
 * - For Anthropic: content mutation (cache_edits deferred to v0.2).
 * - For openai-compat: direct content mutation.
 *
 * Returns a new messages array (does not mutate input).
 */
export function microCompact(
  messages: CanonicalMessage[],
  provider: ProviderKind,
): { messages: CanonicalMessage[]; stats: MicroCompactStats } {
  const allResults = collectToolResults(messages);

  // Only compact results from compactable tools
  const compactable = allResults.filter((r) => COMPACTABLE_TOOLS.has(r.toolName));

  // Preserve the most-recent MICRO_COMPACT_RECENCY results
  const toKeep = new Set<string>();
  const tail = compactable.slice(-MICRO_COMPACT_RECENCY);
  for (const r of tail) toKeep.add(r.toolUseId);

  // Build the set of (msgIndex, blockIndex) pairs to clear
  const toClear = new Set<string>();
  let savedTokens = 0;
  for (const r of compactable) {
    if (!toKeep.has(r.toolUseId)) {
      toClear.add(`${r.msgIndex}:${r.blockIndex}`);
      savedTokens += r.tokenCount;
    }
  }

  if (toClear.size === 0) {
    return { messages, stats: { clearedCount: 0, savedTokens: 0 } };
  }

  // Deep clone messages, mutating only the targeted blocks
  const newMessages: CanonicalMessage[] = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;
    let mutated = false;
    const newContent = msg.content.map((block, bi) => {
      if (toClear.has(`${mi}:${bi}`) && block.type === 'tool_result') {
        mutated = true;
        const originalTokens = estimateToolResultTokens(block);
        return clearToolResultBlock(block, originalTokens);
      }
      return block;
    });
    if (!mutated) return msg;
    return { ...msg, content: newContent };
  });

  logger.debug(
    { clearedCount: toClear.size, savedTokens, provider },
    'microCompact: cleared stale tool results',
  );

  return {
    messages: newMessages,
    stats: { clearedCount: toClear.size, savedTokens },
  };
}

/**
 * Convenience: returns the post-compact token count reduction.
 */
export function microCompactSavings(
  messages: CanonicalMessage[],
  provider: ProviderKind,
): number {
  const { stats } = microCompact(messages, provider);
  return stats.savedTokens;
}
