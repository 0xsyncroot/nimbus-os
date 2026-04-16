// context/index.ts — SPEC-120: barrel export for context compaction module.
// Agent loop integration: import shouldAutoCompact + fullCompact + microCompact.

export {
  shouldAutoCompact,
  roughTokenCount,
  effectiveWindow,
  messagesTokenCount,
  contextWindowFor,
  messageTokens,
  COMPACT_THRESHOLD,
  IMAGE_TOKEN_ESTIMATE,
  MAX_OUTPUT_RESERVE,
} from './tokens.ts';

export {
  fullCompact,
  resetCompactCircuit,
  compactCircuitSnapshot,
  type CompactBoundaryMessage,
  type CompactOpts,
  type CompactResult,
} from './compact.ts';

export {
  microCompact,
  microCompactSavings,
  COMPACTABLE_TOOLS,
  MICRO_COMPACT_RECENCY,
  clearSentinel,
  type ProviderKind,
  type MicroCompactStats,
} from './microCompact.ts';

export {
  slidingWindow,
  slidingWindowCapacity,
  type SlidingWindowResult,
} from './slidingWindow.ts';

export {
  COMPACT_SYSTEM_PROMPT,
  formatCompactPrompt,
  formatCompactSummary,
  validateSummarySections,
  messagesToPlainText,
} from './compactPrompt.ts';
