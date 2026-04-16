// compact.ts — SPEC-120: fullCompact — forked summarisation + boundary marker + circuit breaker.
// Triggered when tokenUsage > 80% of effectiveWindow OR manual /compact command.

import { logger } from '../observability/logger.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { CanonicalMessage, Provider } from '../ir/types.ts';
import {
  effectiveWindow,
  messagesTokenCount,
  roughTokenCount,
  shouldAutoCompact,
} from './tokens.ts';
import {
  COMPACT_SYSTEM_PROMPT,
  formatCompactPrompt,
  formatCompactSummary,
  messagesToPlainText,
} from './compactPrompt.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompactBoundaryMessage {
  type: 'compact_boundary';
  summary: string;
  metadata: {
    trigger: 'auto' | 'manual';
    preTokenCount: number;
    postTokenCount: number;
    preservedSegments?: string[];
  };
}

export interface CompactOpts {
  model: string;
  provider: Provider;
  trigger: 'auto' | 'manual';
  maxOutput?: number;
  /** Abort signal to cancel compaction. */
  signal?: AbortSignal;
}

export interface CompactResult {
  messages: CanonicalMessage[];
  boundary: CompactBoundaryMessage;
  preTokenCount: number;
  postTokenCount: number;
  skipped?: boolean;
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// Circuit breaker state (module-level singleton, reset on process restart)
// ---------------------------------------------------------------------------

interface CompactCircuitState {
  consecutiveFailures: number;
  openUntil: number; // epoch ms; 0 = not open
}

const _circuitState: CompactCircuitState = {
  consecutiveFailures: 0,
  openUntil: 0,
};

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 5 * 60 * 1_000; // 5 minutes

function isCircuitOpen(now = Date.now()): boolean {
  if (_circuitState.openUntil > 0 && now < _circuitState.openUntil) return true;
  if (_circuitState.openUntil > 0 && now >= _circuitState.openUntil) {
    // Auto-reset after cooldown
    _circuitState.consecutiveFailures = 0;
    _circuitState.openUntil = 0;
  }
  return false;
}

function recordCompactSuccess(): void {
  _circuitState.consecutiveFailures = 0;
  _circuitState.openUntil = 0;
}

function recordCompactFailure(now = Date.now()): void {
  _circuitState.consecutiveFailures += 1;
  if (_circuitState.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitState.openUntil = now + CIRCUIT_OPEN_DURATION_MS;
    logger.warn(
      { consecutiveFailures: _circuitState.consecutiveFailures, openUntilMs: _circuitState.openUntil },
      'compact circuit breaker OPEN — auto-compact suspended for 5 minutes',
    );
  }
}

/** For testing: reset the circuit state. */
export function resetCompactCircuit(): void {
  _circuitState.consecutiveFailures = 0;
  _circuitState.openUntil = 0;
}

/** Snapshot of current circuit state. */
export function compactCircuitSnapshot(): Readonly<CompactCircuitState> {
  return { ..._circuitState };
}

// ---------------------------------------------------------------------------
// Forked summarisation call
// ---------------------------------------------------------------------------

/**
 * Calls the provider with the summarisation prompt. `canUseTool` is effectively
 * denied by passing no tools array and using a strict system prompt.
 */
async function callSummarisationProvider(
  conversationText: string,
  opts: CompactOpts,
): Promise<string> {
  const userPrompt = formatCompactPrompt(conversationText);

  const systemBlocks: CanonicalMessage[] = [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
  ];

  // Single user message with the full conversation text
  const messages: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: userPrompt }] },
  ];

  const stream = opts.provider.stream(
    {
      messages: [...systemBlocks, ...messages],
      model: opts.model,
      maxTokens: 4096,
      stream: true,
      // No tools — prevents model from calling tools during compaction
    },
    { signal: opts.signal ?? new AbortController().signal },
  );

  const textParts: string[] = [];
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text' && typeof chunk.delta.text === 'string') {
      textParts.push(chunk.delta.text);
    } else if (chunk.type === 'content_block_start' && chunk.block.type === 'text') {
      textParts.push(chunk.block.text);
    } else if (chunk.type === 'error') {
      throw new NimbusError(ErrorCode.S_COMPACT_FAIL, {
        reason: 'provider_stream_error',
        message: chunk.message,
      });
    }
  }

  return textParts.join('');
}

// ---------------------------------------------------------------------------
// Main fullCompact
// ---------------------------------------------------------------------------

/**
 * Full conversation compaction.
 * - Checks circuit breaker (returns skipped if open)
 * - Calls provider for 9-section summary (no tools allowed)
 * - Returns new slim message list with CompactBoundaryMessage inserted
 */
export async function fullCompact(
  messages: CanonicalMessage[],
  opts: CompactOpts,
): Promise<CompactResult> {
  const preTokenCount = messagesTokenCount(messages);

  // Circuit breaker check
  if (isCircuitOpen()) {
    logger.warn({ consecutiveFailures: _circuitState.consecutiveFailures }, 'compact circuit open — skipping');
    return {
      messages,
      boundary: makeBoundary('', opts.trigger, preTokenCount, preTokenCount),
      preTokenCount,
      postTokenCount: preTokenCount,
      skipped: true,
      skipReason: 'circuit_breaker_open',
    };
  }

  // Guard: don't attempt compact if the compact prompt itself would exceed budget
  const budget = effectiveWindow(opts.model, opts.maxOutput);
  const conversationText = messagesToPlainText(messages);
  const promptTokenEstimate = roughTokenCount(conversationText) + roughTokenCount(COMPACT_SYSTEM_PROMPT);
  if (promptTokenEstimate > budget * 0.95) {
    logger.warn({ promptTokenEstimate, budget }, 'compact prompt too large — falling back to caller');
    return {
      messages,
      boundary: makeBoundary('', opts.trigger, preTokenCount, preTokenCount),
      preTokenCount,
      postTokenCount: preTokenCount,
      skipped: true,
      skipReason: 'prompt_exceeds_budget',
    };
  }

  logger.info(
    { trigger: opts.trigger, preTokenCount, model: opts.model },
    'compact: starting forked summarisation call',
  );

  let rawSummary: string;
  try {
    rawSummary = await callSummarisationProvider(conversationText, opts);
    recordCompactSuccess();
  } catch (err) {
    recordCompactFailure();
    logger.error(
      { err: (err as Error).message, consecutiveFailures: _circuitState.consecutiveFailures },
      'compact: summarisation call failed',
    );
    throw err instanceof NimbusError
      ? err
      : new NimbusError(ErrorCode.S_COMPACT_FAIL, { reason: 'summarisation_failed', cause: (err as Error).message });
  }

  const summary = formatCompactSummary(rawSummary);
  const boundary = makeBoundary(summary, opts.trigger, preTokenCount, 0);

  // Post-compact message list: just the boundary as a synthetic assistant message
  const boundaryMsg: CanonicalMessage = {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `[Context compacted — ${opts.trigger} trigger]\n\n${summary}`,
      },
    ],
  };

  const compactedMessages: CanonicalMessage[] = [boundaryMsg];
  const postTokenCount = messagesTokenCount(compactedMessages);
  boundary.metadata.postTokenCount = postTokenCount;

  logger.info(
    { trigger: opts.trigger, preTokenCount, postTokenCount, model: opts.model },
    'compact: summarisation complete',
  );

  return {
    messages: compactedMessages,
    boundary,
    preTokenCount,
    postTokenCount,
  };
}

function makeBoundary(
  summary: string,
  trigger: 'auto' | 'manual',
  preTokenCount: number,
  postTokenCount: number,
): CompactBoundaryMessage {
  return {
    type: 'compact_boundary',
    summary,
    metadata: { trigger, preTokenCount, postTokenCount },
  };
}

// ---------------------------------------------------------------------------
// Re-export shouldAutoCompact as integration hook (T6)
// ---------------------------------------------------------------------------
export { shouldAutoCompact } from './tokens.ts';
