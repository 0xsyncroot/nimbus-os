// tests/selfHeal/healers.test.ts — SPEC-602: healer unit tests + circuit breaker

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import { createHealCircuit, __resetHealCircuit } from '../../src/selfHeal/circuit.ts';
import { healProvider } from '../../src/selfHeal/healers/provider.ts';
import { healTool } from '../../src/selfHeal/healers/tool.ts';
import { healStorage } from '../../src/selfHeal/healers/storage.ts';
import { healSubsystem } from '../../src/selfHeal/healers/subsystem.ts';

function makeErr(code: ErrorCode, context: Record<string, unknown> = {}): NimbusError {
  return new NimbusError(code, context);
}

describe('SPEC-602: HealCircuit', () => {
  let circuit = createHealCircuit();

  beforeEach(() => {
    circuit = createHealCircuit();
  });

  test('not open initially', () => {
    expect(circuit.isOpen('P_NETWORK')).toBe(false);
  });

  test('3 failures within window → open', () => {
    const now = 1000;
    circuit.recordFailure('P_NETWORK', now);
    circuit.recordFailure('P_NETWORK', now + 1000);
    circuit.recordFailure('P_NETWORK', now + 2000);
    expect(circuit.isOpen('P_NETWORK', now + 3000)).toBe(true);
  });

  test('failures outside window do not count', () => {
    const now = 1000;
    circuit.recordFailure('P_NETWORK', now);
    circuit.recordFailure('P_NETWORK', now + 1000);
    // gap > 60s resets streak
    circuit.recordFailure('P_NETWORK', now + 70_000);
    expect(circuit.isOpen('P_NETWORK', now + 71_000)).toBe(false);
  });

  test('open expires after 5min', () => {
    const now = 1000;
    // 3rd failure at now+2000 → openUntil = (now+2000) + 5min = now+302000
    circuit.recordFailure('P_NETWORK', now);
    circuit.recordFailure('P_NETWORK', now + 1000);
    circuit.recordFailure('P_NETWORK', now + 2000);
    // before expiry (now+4min still within the 5min window from the 3rd failure)
    expect(circuit.isOpen('P_NETWORK', now + 2000 + 4 * 60 * 1000)).toBe(true);
    // after 5min from the 3rd failure
    expect(circuit.isOpen('P_NETWORK', now + 2000 + 5 * 60 * 1000 + 100)).toBe(false);
  });

  test('recordSuccess resets circuit', () => {
    const now = 1000;
    circuit.recordFailure('P_NETWORK', now);
    circuit.recordFailure('P_NETWORK', now + 1000);
    circuit.recordFailure('P_NETWORK', now + 2000);
    circuit.recordSuccess('P_NETWORK');
    expect(circuit.isOpen('P_NETWORK', now + 3000)).toBe(false);
  });

  test('different codes are isolated', () => {
    const now = 1000;
    circuit.recordFailure('P_NETWORK', now);
    circuit.recordFailure('P_NETWORK', now + 1000);
    circuit.recordFailure('P_NETWORK', now + 2000);
    expect(circuit.isOpen('P_5XX', now + 3000)).toBe(false);
    expect(circuit.isOpen('P_NETWORK', now + 3000)).toBe(true);
  });

  test('reset() clears all state', () => {
    circuit.recordFailure('P_NETWORK', 1000);
    circuit.recordFailure('P_NETWORK', 2000);
    circuit.recordFailure('P_NETWORK', 3000);
    circuit.reset();
    expect(circuit.isOpen('P_NETWORK', 4000)).toBe(false);
  });
});

describe('SPEC-602: healProvider', () => {
  test('P_NETWORK attempt 1 → retry', () => {
    const d = healProvider(makeErr(ErrorCode.P_NETWORK), 1);
    expect(d.action).toBe('retry');
    expect(d.delayMs).toBeGreaterThan(0);
  });

  test('P_NETWORK attempt 3 → escalate', () => {
    const d = healProvider(makeErr(ErrorCode.P_NETWORK), 3);
    expect(d.action).toBe('escalate');
  });

  test('P_5XX attempt 2 → retry with toast', () => {
    const d = healProvider(makeErr(ErrorCode.P_5XX), 2);
    expect(d.action).toBe('retry');
    expect(d.notify).toBe('toast');
  });

  test('P_AUTH → escalate loud, 0 retries', () => {
    const d = healProvider(makeErr(ErrorCode.P_AUTH), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });

  test('P_CONTEXT_OVERFLOW → compact-then-retry', () => {
    const d = healProvider(makeErr(ErrorCode.P_CONTEXT_OVERFLOW), 1);
    expect(d.action).toBe('compact-then-retry');
  });

  test('P_429 uses retryAfterMs from context', () => {
    const d = healProvider(makeErr(ErrorCode.P_429, { retryAfterMs: 5000 }), 1);
    expect(d.action).toBe('retry');
    expect(d.delayMs).toBe(5000);
  });

  test('P_MODEL_NOT_FOUND attempt 2 → switch-model', () => {
    const d = healProvider(makeErr(ErrorCode.P_MODEL_NOT_FOUND), 2);
    expect(d.action).toBe('switch-model');
  });
});

describe('SPEC-602: healTool', () => {
  test('T_CRASH attempt 1 → retry', () => {
    const d = healTool(makeErr(ErrorCode.T_CRASH), 1);
    expect(d.action).toBe('retry');
  });

  test('T_CRASH attempt 2 → feed-to-llm', () => {
    const d = healTool(makeErr(ErrorCode.T_CRASH), 2);
    expect(d.action).toBe('feed-to-llm');
  });

  test('T_VALIDATION → feed-to-llm', () => {
    const d = healTool(makeErr(ErrorCode.T_VALIDATION), 1);
    expect(d.action).toBe('feed-to-llm');
  });

  test('T_PERMISSION → escalate loud', () => {
    const d = healTool(makeErr(ErrorCode.T_PERMISSION), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });

  test('T_TIMEOUT attempt 1 → retry', () => {
    const d = healTool(makeErr(ErrorCode.T_TIMEOUT), 1);
    expect(d.action).toBe('retry');
  });

  test('T_TIMEOUT attempt 2 → escalate', () => {
    const d = healTool(makeErr(ErrorCode.T_TIMEOUT), 2);
    expect(d.action).toBe('escalate');
  });

  test('T_MCP_UNAVAILABLE attempt 1 → retry', () => {
    const d = healTool(makeErr(ErrorCode.T_MCP_UNAVAILABLE), 1);
    expect(d.action).toBe('retry');
  });

  test('T_ITERATION_CAP → escalate banner', () => {
    const d = healTool(makeErr(ErrorCode.T_ITERATION_CAP), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('banner');
  });

  test('T_NOT_FOUND → feed-to-llm', () => {
    const d = healTool(makeErr(ErrorCode.T_NOT_FOUND), 1);
    expect(d.action).toBe('feed-to-llm');
  });
});

describe('SPEC-602: healStorage', () => {
  test('S_STORAGE_CORRUPT attempt 1 → retry', () => {
    const d = healStorage(makeErr(ErrorCode.S_STORAGE_CORRUPT), 1);
    expect(d.action).toBe('retry');
  });

  test('S_STORAGE_CORRUPT attempt 2 → escalate', () => {
    const d = healStorage(makeErr(ErrorCode.S_STORAGE_CORRUPT), 2);
    expect(d.action).toBe('escalate');
  });

  test('S_COMPACT_FAIL attempt 1 → retry with message', () => {
    const d = healStorage(makeErr(ErrorCode.S_COMPACT_FAIL), 1);
    expect(d.action).toBe('retry');
    expect(d.message).toBeDefined();
  });

  test('S_SOUL_PARSE → escalate loud', () => {
    const d = healStorage(makeErr(ErrorCode.S_SOUL_PARSE), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });

  test('S_CONFIG_INVALID → feed-to-llm', () => {
    const d = healStorage(makeErr(ErrorCode.S_CONFIG_INVALID), 1);
    expect(d.action).toBe('feed-to-llm');
  });
});

describe('SPEC-602: healSubsystem', () => {
  test('Y_OOM → escalate loud', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_OOM), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });

  test('Y_SUBAGENT_CRASH attempt 1 → retry', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_SUBAGENT_CRASH), 1);
    expect(d.action).toBe('retry');
  });

  test('Y_SUBAGENT_CRASH attempt 2 → escalate', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_SUBAGENT_CRASH), 2);
    expect(d.action).toBe('escalate');
  });

  test('Y_DAEMON_CRASH → escalate loud', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_DAEMON_CRASH), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });

  test('Y_CIRCUIT_BREAKER_OPEN → escalate banner', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_CIRCUIT_BREAKER_OPEN, { retryAfterMs: 60000 }), 1);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('banner');
  });

  test('Y_DISK_FULL attempt 1 → retry (prune attempted)', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_DISK_FULL), 1);
    expect(d.action).toBe('retry');
  });

  test('Y_DISK_FULL attempt 2 → escalate loud', async () => {
    const d = await healSubsystem(makeErr(ErrorCode.Y_DISK_FULL), 2);
    expect(d.action).toBe('escalate');
    expect(d.notify).toBe('loud');
  });
});
