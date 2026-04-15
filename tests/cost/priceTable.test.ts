// tests/cost/priceTable.test.ts — SPEC-701 §6.1

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetPriceWarnings,
  computeCost,
  lookupPrice,
  resolveClass,
} from '../../src/cost/priceTable.ts';

beforeEach(() => __resetPriceWarnings());

describe('SPEC-701: priceTable', () => {
  test('exact match opus-4-6 1M in + 1M out = $90', () => {
    const { costUsd } = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      'anthropic',
      'opus-4-6',
    );
    expect(costUsd).toBe(90);
  });

  test('cache read 1M on opus-4-6 = $1.5', () => {
    const { costUsd } = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      'anthropic',
      'opus-4-6',
    );
    expect(costUsd).toBe(1.5);
  });

  test('sonnet-4-6: 1000 in + 500 out + 2000 cacheRead = $0.0111', () => {
    const { costUsd, costSavedUsd } = computeCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      'anthropic',
      'sonnet-4-6',
    );
    // 1000*3/1e6 + 500*15/1e6 + 2000*0.3/1e6 = 0.003 + 0.0075 + 0.0006 = 0.0111
    expect(costUsd).toBeCloseTo(0.0111, 6);
    // Savings: would-have-been at input rate = 2000*3/1e6 = 0.006; paid = 0.0006; saved = 0.0054
    expect(costSavedUsd).toBeCloseTo(0.0054, 6);
  });

  test('fuzzy: claude-sonnet-4-5-preview-20260101 → sonnet-4-5 tier', () => {
    const p = lookupPrice('anthropic', 'claude-sonnet-4-5-preview-20260101');
    expect(p.in).toBe(3);
    expect(p.class).toBe('workhorse');
  });

  test('ollama any model → $0', () => {
    const { costUsd } = computeCost(
      {
        inputTokens: 100_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      'ollama',
      'llama3-custom',
    );
    expect(costUsd).toBe(0);
    expect(resolveClass('ollama', 'llama3-custom')).toBe('local');
  });

  test('unknown provider → $0 fallback', () => {
    const { costUsd } = computeCost(
      { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      'unknown-provider',
      'some-model',
    );
    expect(costUsd).toBe(0);
  });

  test('gpt-4o-mini fuzzy: gpt-4o-mini-2026 → gpt-4o-mini tier', () => {
    const p = lookupPrice('openai', 'gpt-4o-mini-2026');
    expect(p.in).toBe(0.15);
    expect(p.class).toBe('budget');
  });
});
