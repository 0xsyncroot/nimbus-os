// tests/cost/accountant.test.ts — SPEC-701 §6.1

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspacesDir } from '../../src/platform/paths.ts';
import { recordCost } from '../../src/cost/accountant.ts';
import { readIndex, readMonth, monthKey } from '../../src/cost/ledger.ts';

const OVERRIDE = join(
  tmpdir(),
  `nimbus-cost-acct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  await rm(workspacesDir(), { recursive: true, force: true });
});

describe('SPEC-701: accountant.recordCost', () => {
  test('records event with correct cost and savings for sonnet-4-6', async () => {
    const ev = await recordCost({
      workspaceId: 'ws1',
      sessionId: 's1',
      turnId: 't1',
      provider: 'anthropic',
      model: 'sonnet-4-6',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      channel: 'cli',
    });
    expect(ev.costUsd).toBeCloseTo(0.0111, 6);
    expect(ev.costSavedUsd).toBeCloseTo(0.0054, 6);
    expect(ev.modelClass).toBe('workhorse');
    expect(ev.provider).toBe('anthropic');
  });

  test('ledger writes to YYYY-MM.jsonl and updates _index', async () => {
    const ev = await recordCost({
      workspaceId: 'ws2',
      sessionId: 's1',
      turnId: 't1',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      channel: 'cli',
      ts: Date.UTC(2026, 3, 15),
    });
    const month = monthKey(ev.ts);
    const events = await readMonth('ws2', month);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(ev.id);

    const idx = await readIndex('ws2');
    expect(idx).not.toBeNull();
    expect(idx!.months[month]!.events).toBe(1);
    expect(idx!.months[month]!.totalUsd).toBeCloseTo(ev.costUsd, 6);
  });

  test('month rollover produces separate files', async () => {
    await recordCost({
      workspaceId: 'ws3',
      sessionId: 's1',
      turnId: 't1',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: Date.UTC(2026, 0, 15),
    });
    await recordCost({
      workspaceId: 'ws3',
      sessionId: 's1',
      turnId: 't2',
      provider: 'anthropic',
      model: 'haiku-4-5',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      channel: 'cli',
      ts: Date.UTC(2026, 1, 15),
    });
    const jan = await readMonth('ws3', '2026-01');
    const feb = await readMonth('ws3', '2026-02');
    expect(jan).toHaveLength(1);
    expect(feb).toHaveLength(1);
  });
});
