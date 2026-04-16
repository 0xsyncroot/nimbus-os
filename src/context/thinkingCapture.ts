// thinkingCapture.ts — SPEC-116: capture extended thinking blocks from provider responses.
// Thinking blocks are stored in a session-scoped ring buffer (max 50, FIFO).
// Never forwarded to next provider turn; never written to logger.

import { z } from 'zod';
import type { CanonicalBlock } from '../ir/types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_TRACES = 50;

// Models that support extended thinking (allowlist + glob suffix).
const THINKING_ALLOWLIST: ReadonlySet<string> = new Set([
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
]);

const THINKING_SUFFIX = '-thinking';

// ---------------------------------------------------------------------------
// Schema / types
// ---------------------------------------------------------------------------

export const ThinkingBlockSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  turnId: z.string(),
  sessionId: z.string(),
  type: z.literal('thinking.block'),
  content: z.string(),
  tokenCount: z.number(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

export interface ThinkingTrace {
  turnId: string;
  model: string;
  effort: string;
  text: string;
  tokens: number;
  timestamp: number;
}

export interface GetTracesOpts {
  turnId?: string;
}

// ---------------------------------------------------------------------------
// Session-scoped store (module-level map, keyed by sessionId)
// ---------------------------------------------------------------------------

const sessionTraces = new Map<string, ThinkingTrace[]>();

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export function supportsThinking(model: string): boolean {
  if (THINKING_ALLOWLIST.has(model)) return true;
  if (model.endsWith(THINKING_SUFFIX)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Extract thinking blocks from a CanonicalBlock array and store them
 * in the session-scoped ring buffer (max MAX_TRACES, FIFO).
 * No-op if blocks is empty or contains no thinking blocks.
 */
export function captureThinking(
  sessionId: string,
  turnId: string,
  model: string,
  effort: string,
  blocks: CanonicalBlock[],
): void {
  const thinkingBlocks = blocks.filter((b): b is Extract<CanonicalBlock, { type: 'thinking' }> => b.type === 'thinking');
  if (thinkingBlocks.length === 0) return;

  let traces = sessionTraces.get(sessionId);
  if (!traces) {
    traces = [];
    sessionTraces.set(sessionId, traces);
  }

  for (const block of thinkingBlocks) {
    const trace: ThinkingTrace = {
      turnId,
      model,
      effort,
      text: block.text,
      tokens: Math.ceil(block.text.length / 4), // rough estimate
      timestamp: Date.now(),
    };
    traces.push(trace);
    // FIFO eviction: drop oldest when over cap
    if (traces.length > MAX_TRACES) {
      traces.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Return traces for a session, optionally filtered by turnId.
 * Returns a shallow copy to prevent external mutation.
 */
export function getTraces(sessionId: string, opts?: GetTracesOpts): ThinkingTrace[] {
  const traces = sessionTraces.get(sessionId) ?? [];
  if (opts?.turnId !== undefined) {
    return traces.filter(t => t.turnId === opts.turnId);
  }
  return [...traces];
}

/**
 * Return the most recent trace for a session (or null if none).
 */
export function getLastTrace(sessionId: string): ThinkingTrace | null {
  const traces = sessionTraces.get(sessionId);
  if (!traces || traces.length === 0) return null;
  return traces[traces.length - 1] ?? null;
}

/**
 * Clear all traces for a session (e.g. on session teardown).
 */
export function clearTraces(sessionId: string): void {
  sessionTraces.delete(sessionId);
}
