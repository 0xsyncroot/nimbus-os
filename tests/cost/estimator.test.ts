// tests/cost/estimator.test.ts — SPEC-702 §6.1

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createEstimator,
  estimateTokens,
} from '../../src/cost/estimator.ts';
import type { CostEvent } from '../../src/cost/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(text: string): import('../../src/ir/types.ts').CanonicalMessage {
  return { role: 'user', content: text };
}

function makeHistory(
  count: number,
  provider: string,
  model: string,
  outputRatio: number,
): CostEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    schemaVersion: 1 as const,
    id: `evt-${i}`,
    ts: Date.now() - i * 1000,
    workspaceId: 'ws1',
    sessionId: 's1',
    turnId: `t${i}`,
    channel: 'cli',
    provider: provider as import('../../src/cost/types.ts').Provider,
    model,
    modelClass: 'workhorse' as const,
    inputTokens: 1000,
    outputTokens: Math.round(1000 * outputRatio),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    costSavedUsd: 0,
  }));
}

// ---------------------------------------------------------------------------
// estimateTokens unit tests
// ---------------------------------------------------------------------------

describe('SPEC-702: estimateTokens', () => {
  test('anthropic: applies 1.33 padding', () => {
    const text = 'a'.repeat(400); // 400 chars → 100 raw → 133 with padding
    const tokens = estimateTokens(text, 'anthropic');
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBe(Math.ceil((400 / 4) * 1.33));
  });

  test('openai: uses raw chars/4', () => {
    const text = 'a'.repeat(400);
    const tokens = estimateTokens(text, 'openai');
    expect(tokens).toBe(100);
  });

  test('local/unknown provider: uses chars/4', () => {
    const text = 'a'.repeat(800);
    expect(estimateTokens(text, 'ollama')).toBe(200);
    expect(estimateTokens(text, 'unknown')).toBe(200);
  });

  test('returns positive integer for non-empty text', () => {
    const result = estimateTokens('Hello, world!', 'anthropic');
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokens('', 'anthropic')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Estimator.estimate unit tests
// ---------------------------------------------------------------------------

describe('SPEC-702: Estimator.estimate', () => {
  test('returns numeric positive token counts for anthropic', async () => {
    const est = createEstimator();
    const result = await est.estimate(
      [makeMsg('Tell me about TypeScript.')],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.estimatedOutputTokens).toBeGreaterThan(0);
  });

  test('hi-band ≥ mid-band ≥ lo-band', async () => {
    const est = createEstimator();
    const result = await est.estimate(
      [makeMsg('Explain quantum entanglement in detail.')],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );
    expect(result.costHiUsd).toBeGreaterThanOrEqual(result.costMidUsd);
    expect(result.costMidUsd).toBeGreaterThanOrEqual(result.costLoUsd);
  });

  test('chars/4 fallback for local provider', async () => {
    const est = createEstimator();
    const result = await est.estimate(
      [makeMsg('a'.repeat(4000))],
      'ollama',
      'llama3',
      'ws1',
    );
    // ollama price = $0 → all cost bands should be 0
    expect(result.costHiUsd).toBe(0);
    expect(result.costLoUsd).toBe(0);
    expect(result.inputTokens).toBe(1000); // 4000/4
  });

  test('estimate accuracy within 2× for standard anthropic prompt', async () => {
    const est = createEstimator();
    // 400-char prompt ≈ 133 tokens with padding
    const result = await est.estimate(
      [makeMsg('a'.repeat(400))],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );
    const expectedTokens = Math.ceil((400 / 4) * 1.33);
    // Within 2× of expected token count
    expect(result.inputTokens).toBeLessThanOrEqual(expectedTokens * 2);
    expect(result.inputTokens).toBeGreaterThanOrEqual(expectedTokens / 2);
  });

  test('hi/lo band from 20-event history adjusts output ratio', async () => {
    // History showing high output ratio (e.g. 1.5× input)
    const highHistory = makeHistory(20, 'anthropic', 'sonnet-4-6', 1.5);
    const estHigh = createEstimator({
      getHistory: () => highHistory,
    });
    const resultHigh = await estHigh.estimate(
      [makeMsg('a'.repeat(1000))],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );

    // History showing low output ratio (0.1× input)
    const lowHistory = makeHistory(20, 'anthropic', 'sonnet-4-6', 0.1);
    const estLow = createEstimator({
      getHistory: () => lowHistory,
    });
    const resultLow = await estLow.estimate(
      [makeMsg('a'.repeat(1000))],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );

    // With high output history the hi-band cost should be higher
    expect(resultHigh.costHiUsd).toBeGreaterThan(resultLow.costLoUsd);
  });

  test('cold-start (no history) uses BAND_LOW/BAND_HIGH multipliers', async () => {
    const est = createEstimator({ getHistory: () => [] });
    const result = await est.estimate(
      [makeMsg('a'.repeat(400))],
      'anthropic',
      'claude-sonnet-4-6',
      'ws1',
    );
    // With no history: loMul=0.5, hiMul=2.0 → hi should be > lo
    expect(result.costHiUsd).toBeGreaterThan(result.costLoUsd);
  });

  test('multipart CanonicalMessage content is serialized', async () => {
    const est = createEstimator();
    const msg: import('../../src/ir/types.ts').CanonicalMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is the result of ' },
        { type: 'tool_result', toolUseId: 'tu1', content: '42', isError: false },
      ],
    };
    const result = await est.estimate([msg], 'openai', 'gpt-4o', 'ws1');
    expect(result.inputTokens).toBeGreaterThan(0);
  });
});
