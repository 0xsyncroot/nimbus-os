// tests/selfHeal/engine.test.ts — SPEC-602: SelfHealEngine unit tests

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import { createSelfHealEngine } from '../../src/selfHeal/engine.ts';
import { createHealCircuit, __resetHealCircuit } from '../../src/selfHeal/circuit.ts';
import { __resetSelfHealEngine } from '../../src/selfHeal/engine.ts';

function makeErr(code: ErrorCode, context: Record<string, unknown> = {}): NimbusError {
  return new NimbusError(code, context);
}

describe('SPEC-602: SelfHealEngine', () => {
  beforeEach(() => {
    __resetHealCircuit();
    __resetSelfHealEngine();
  });
  afterEach(() => {
    __resetHealCircuit();
    __resetSelfHealEngine();
  });

  describe('security gate', () => {
    const X_CODES = [
      ErrorCode.X_BASH_BLOCKED,
      ErrorCode.X_PATH_BLOCKED,
      ErrorCode.X_NETWORK_BLOCKED,
      ErrorCode.X_INJECTION,
      ErrorCode.X_CRED_ACCESS,
      ErrorCode.X_AUDIT_BREAK,
    ];

    for (const code of X_CODES) {
      test(`${code} → escalate immediately, no state write`, async () => {
        const engine = createSelfHealEngine();
        const decision = await engine.handle(makeErr(code), { turnId: 'turn1' });
        expect(decision.action).toBe('escalate');
        expect(decision.notify).toBe('loud');
        // Call again — same result (no state increment that could change behavior)
        const decision2 = await engine.handle(makeErr(code), { turnId: 'turn1' });
        expect(decision2.action).toBe('escalate');
      });
    }
  });

  describe('provider healer', () => {
    test('P_NETWORK first attempt → retry with delay', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turn1' });
      expect(d.action).toBe('retry');
      expect(d.delayMs).toBeGreaterThan(0);
    });

    test('P_NETWORK 3 attempts → escalate', async () => {
      const engine = createSelfHealEngine();
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turn1' });
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turn1' });
      const d = await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turn1' });
      expect(d.action).toBe('escalate');
    });

    test('P_AUTH → escalate immediately with loud notify', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.P_AUTH), { turnId: 'turn1' });
      expect(d.action).toBe('escalate');
      expect(d.notify).toBe('loud');
    });

    test('P_CONTEXT_OVERFLOW → compact-then-retry', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.P_CONTEXT_OVERFLOW), { turnId: 'turn1' });
      expect(d.action).toBe('compact-then-retry');
    });

    test('P_429 honors retry-after from context', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(
        makeErr(ErrorCode.P_429, { retryAfterMs: 12345 }),
        { turnId: 'turn1' },
      );
      expect(d.action).toBe('retry');
      expect(d.delayMs).toBe(12345);
    });
  });

  describe('tool healer', () => {
    test('T_CRASH first attempt → retry', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.T_CRASH), { turnId: 'turn1' });
      expect(d.action).toBe('retry');
    });

    test('T_CRASH second attempt → feed-to-llm', async () => {
      const engine = createSelfHealEngine();
      await engine.handle(makeErr(ErrorCode.T_CRASH), { turnId: 'turn1' });
      const d = await engine.handle(makeErr(ErrorCode.T_CRASH), { turnId: 'turn1' });
      expect(d.action).toBe('feed-to-llm');
    });

    test('T_VALIDATION → feed-to-llm', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.T_VALIDATION), { turnId: 'turn1' });
      expect(d.action).toBe('feed-to-llm');
    });

    test('T_PERMISSION → escalate loud', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.T_PERMISSION), { turnId: 'turn1' });
      expect(d.action).toBe('escalate');
      expect(d.notify).toBe('loud');
    });
  });

  describe('storage healer', () => {
    test('S_COMPACT_FAIL first attempt → retry', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.S_COMPACT_FAIL), { turnId: 'turn1' });
      expect(d.action).toBe('retry');
    });

    test('S_SOUL_PARSE → escalate loud', async () => {
      const engine = createSelfHealEngine();
      const d = await engine.handle(makeErr(ErrorCode.S_SOUL_PARSE), { turnId: 'turn1' });
      expect(d.action).toBe('escalate');
      expect(d.notify).toBe('loud');
    });
  });

  describe('cross-turn isolation', () => {
    test('turnA errors do not pollute turnB state', async () => {
      const engine = createSelfHealEngine();
      // Drive turnA to 3 attempts
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      // turnB should start fresh (attempt 1 = retry)
      const d = await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnB' });
      expect(d.action).toBe('retry');
    });

    test('resetTurn clears state for that turn', async () => {
      const engine = createSelfHealEngine();
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      engine.resetTurn('turnA');
      const d = await engine.handle(makeErr(ErrorCode.P_NETWORK), { turnId: 'turnA' });
      expect(d.action).toBe('retry');
    });
  });
});
