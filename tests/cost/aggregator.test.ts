// tests/cost/aggregator.test.ts — SPEC-701 §6.1

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspacesDir } from '../../src/platform/paths.ts';
import { recordCost } from '../../src/cost/accountant.ts';
import {
  __clearAggregatorCache,
  aggregate,
  rollupEvents,
} from '../../src/cost/aggregator.ts';
import { readMonth } from '../../src/cost/ledger.ts';
import { renderRollup } from '../../src/cost/dashboard.ts';

const OVERRIDE = join(
  tmpdir(),
  `nimbus-cost-agg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  __clearAggregatorCache();
  await rm(workspacesDir(), { recursive: true, force: true });
});

describe('SPEC-701: aggregator', () => {
  test('rollup today — sums match raw ledger', async () => {
    const now = Date.now();
    await recordCost({
      workspaceId: 'wsA',
      sessionId: 'sess-1',
      turnId: 't1',
      provider: 'anthropic',
      model: 'sonnet-4-6',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: now,
    });
    await recordCost({
      workspaceId: 'wsA',
      sessionId: 'sess-2',
      turnId: 't1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: now,
    });
    const r = await aggregate('wsA', 'today', { now, bypassCache: true });
    expect(r.events).toBe(2);
    expect(Object.keys(r.byProvider).sort()).toEqual(['anthropic', 'openai']);
    expect(Object.keys(r.bySession).length).toBe(2);
    // Total = 0.003+0.0075 + 0.00015+0.0003 = 0.01095
    expect(r.totalUsd).toBeCloseTo(0.01095, 6);
  });

  test('outside window → excluded', async () => {
    const now = Date.now();
    const old = now - 45 * 86_400_000; // 45 days ago
    await recordCost({
      workspaceId: 'wsB',
      sessionId: 's',
      turnId: 't',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: old,
    });
    const r = await aggregate('wsB', 'month', { now, bypassCache: true });
    expect(r.events).toBe(0);
  });

  test('cache returns stable result within 5 min', async () => {
    const now = Date.now();
    await recordCost({
      workspaceId: 'wsC',
      sessionId: 's',
      turnId: 't1',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: now,
    });
    const first = await aggregate('wsC', 'today', { now });
    // Inject a new event — cached result should not reflect it.
    await recordCost({
      workspaceId: 'wsC',
      sessionId: 's',
      turnId: 't2',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: now,
    });
    const second = await aggregate('wsC', 'today', { now });
    expect(second.events).toBe(first.events);
    const third = await aggregate('wsC', 'today', { now, bypassCache: true });
    expect(third.events).toBe(2);
  });

  test('rollupEvents groups by day', async () => {
    const base = Date.UTC(2026, 3, 10);
    const events = [
      { day1: base },
      { day1: base + 3600_000 },
      { day2: base + 86_400_000 },
    ];
    const rollups = await (async () => {
      for (const e of events) {
        const ts = Object.values(e)[0]!;
        await recordCost({
          workspaceId: 'wsD',
          sessionId: 's',
          turnId: 't',
          provider: 'anthropic',
          model: 'haiku-4-5',
          usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          channel: 'cli',
          ts,
        });
      }
      const m = await readMonth('wsD', '2026-04');
      return rollupEvents(m);
    })();
    expect(Object.keys(rollups.byDay).length).toBe(2);
  });

  test('renderRollup today renders non-empty', async () => {
    const now = Date.now();
    await recordCost({
      workspaceId: 'wsE',
      sessionId: 'abcdef1234567890',
      turnId: 't',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: now,
    });
    const r = await aggregate('wsE', 'today', { now, bypassCache: true });
    const out = renderRollup(r, { window: 'today', by: 'session' });
    expect(out).toContain('Cost — Today');
    // Redaction — first 8 chars then ellipsis.
    expect(out).toContain('abcdef12');
    expect(out).not.toContain('abcdef1234567890');
  });
});
