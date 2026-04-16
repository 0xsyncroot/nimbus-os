// estimator.ts — SPEC-702 T1+T2: token counter + hi/lo cost band estimator.
// Anthropic/OpenAI/local providers; P25/P90 band from last 20 CostEvents.

import { logger } from '../observability/logger.ts';
import type { CanonicalMessage } from '../ir/types.ts';
import { lookupPrice } from './priceTable.ts';
import type { CostEvent } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Average chars per token across major tokenizers. */
const CHARS_PER_TOKEN = 4;
/** Anthropic-specific padding: BPE overhead ≈ 1.33×. */
const ANTHROPIC_PADDING = 1.33;
/** Typical assistant output is ~40% of input. */
const OUTPUT_RATIO = 0.4;
/** Cost bands: P25 = 0.5×, P50 = 1×, P90 = 2×. */
const BAND_LOW = 0.5;
const BAND_HIGH = 2.0;
/** Warn threshold: high-end estimate ≥ $0.20. */
const WARN_THRESHOLD_USD = 0.2;
/** History window for P25/P90 calculation. */
const HISTORY_WINDOW = 20;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TokenEstimate {
  inputTokens: number;
  estimatedOutputTokens: number;
  /** P25 cost estimate (USD). */
  costLoUsd: number;
  /** P50 cost estimate (USD) — single-point mid. */
  costMidUsd: number;
  /** P90 cost estimate (USD). */
  costHiUsd: number;
}

export interface Estimator {
  estimate(
    messages: CanonicalMessage[],
    provider: string,
    model: string,
    workspaceId: string,
  ): Promise<TokenEstimate>;
}

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

/**
 * Serialize all message content to a plain text string for heuristic counting.
 * Does NOT include prompt content in debug logs (security rule).
 */
function serializeMessages(messages: CanonicalMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') parts.push(block.text);
        else if (block.type === 'thinking') parts.push(block.text);
        else if (block.type === 'tool_use') parts.push(JSON.stringify(block.input));
        else if (block.type === 'tool_result') {
          if (typeof block.content === 'string') parts.push(block.content);
          else {
            for (const inner of block.content) {
              if (inner.type === 'text') parts.push(inner.text);
            }
          }
        }
      }
    }
  }
  return parts.join(' ');
}

/**
 * Heuristic token count: chars / CHARS_PER_TOKEN with optional provider padding.
 */
export function estimateTokens(text: string, provider: string): number {
  const raw = Math.ceil(text.length / CHARS_PER_TOKEN);
  if (provider === 'anthropic') return Math.ceil(raw * ANTHROPIC_PADDING);
  // OpenAI tiktoken ≈ same heuristic (tiktoken is optional dep; chars/4 is a safe fallback)
  if (provider === 'openai') return raw;
  // local / groq / deepseek / unknown → chars/4
  return raw;
}

// ---------------------------------------------------------------------------
// Cost band calculation
// ---------------------------------------------------------------------------

function computeMidCost(
  inputTokens: number,
  outputTokens: number,
  provider: string,
  model: string,
): number {
  const price = lookupPrice(provider, model);
  const MIL = 1_000_000;
  return (inputTokens / MIL) * price.in + (outputTokens / MIL) * price.out;
}

/**
 * Derive hi/lo band from historical CostEvents (last N for this provider+model).
 * Falls back to BAND_LOW/BAND_HIGH multipliers on cold-start.
 */
function deriveMultipliers(
  history: CostEvent[],
  provider: string,
  model: string,
): { loMul: number; hiMul: number } {
  const relevant = history
    .filter((e) => e.provider === provider && e.model.includes(model.slice(0, 8)))
    .slice(-HISTORY_WINDOW);

  if (relevant.length < 3) {
    return { loMul: BAND_LOW, hiMul: BAND_HIGH };
  }

  // Compute actual / estimated ratio for each event as a ratio of output to input tokens.
  const ratios = relevant.map((e) => {
    if (e.inputTokens === 0) return 1;
    return e.outputTokens / e.inputTokens;
  }).sort((a, b) => a - b);

  const p25 = ratios[Math.floor(ratios.length * 0.25)] ?? ratios[0]!;
  const p90 = ratios[Math.floor(ratios.length * 0.9)] ?? ratios[ratios.length - 1]!;

  // Normalize: mid ratio ≈ OUTPUT_RATIO → scale multipliers around that.
  const midRatio = ratios[Math.floor(ratios.length * 0.5)] ?? OUTPUT_RATIO;
  const base = midRatio === 0 ? OUTPUT_RATIO : midRatio;

  return {
    loMul: Math.max(0.1, p25 / base),
    hiMul: Math.min(10, p90 / base),
  };
}

// ---------------------------------------------------------------------------
// Estimator factory
// ---------------------------------------------------------------------------

/**
 * Create an Estimator backed by optional history injection (for testing) or
 * the provided history callback.
 */
export function createEstimator(opts: {
  getHistory?: (workspaceId: string, provider: string) => CostEvent[];
} = {}): Estimator {
  return {
    async estimate(
      messages: CanonicalMessage[],
      provider: string,
      model: string,
      workspaceId: string,
    ): Promise<TokenEstimate> {
      const text = serializeMessages(messages);
      const inputTokens = estimateTokens(text, provider);
      const outputTokens = Math.ceil(inputTokens * OUTPUT_RATIO);

      const history = opts.getHistory
        ? opts.getHistory(workspaceId, provider)
        : [];

      const { loMul, hiMul } = deriveMultipliers(history, provider, model);

      const midCost = computeMidCost(inputTokens, outputTokens, provider, model);
      const loOutput = Math.ceil(outputTokens * loMul);
      const hiOutput = Math.ceil(outputTokens * hiMul);
      const costLoUsd = round6(computeMidCost(inputTokens, loOutput, provider, model));
      const costMidUsd = round6(midCost);
      const costHiUsd = round6(computeMidCost(inputTokens, hiOutput, provider, model));

      if (costHiUsd >= WARN_THRESHOLD_USD) {
        logger.warn(
          { provider, model, costHiUsd },
          'estimator: high cost estimate — consider a smaller model',
        );
      }

      return { inputTokens, estimatedOutputTokens: outputTokens, costLoUsd, costMidUsd, costHiUsd };
    },
  };
}

/** Default singleton estimator (no history). */
export const defaultEstimator: Estimator = createEstimator();

// ---------------------------------------------------------------------------
// Convenience helpers (used by budget.ts)
// ---------------------------------------------------------------------------

export { WARN_THRESHOLD_USD };

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
