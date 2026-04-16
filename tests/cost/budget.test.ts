// tests/cost/budget.test.ts — SPEC-702 §6.1

import { afterEach, describe, expect, test } from 'bun:test';
import {
  BudgetConfigSchema,
  __resetBudgetState,
  createBudgetEnforcer,
  nextModelClass,
  parseBudgetSlash,
} from '../../src/cost/budget.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { TokenEstimate } from '../../src/cost/estimator.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEstimate(
  midUsd: number,
  hiUsd?: number,
  loUsd?: number,
): TokenEstimate {
  const hi = hiUsd ?? midUsd * 2;
  const lo = loUsd ?? midUsd * 0.5;
  return {
    inputTokens: 1000,
    estimatedOutputTokens: 400,
    costLoUsd: lo,
    costMidUsd: midUsd,
    costHiUsd: hi,
  };
}

afterEach(() => {
  __resetBudgetState();
});

// ---------------------------------------------------------------------------
// BudgetConfig schema
// ---------------------------------------------------------------------------

describe('SPEC-702: BudgetConfigSchema', () => {
  test('valid config parses correctly', () => {
    const config = BudgetConfigSchema.parse({ dailyBudget: 1.5, mode: 'warn' });
    expect(config.dailyBudget).toBe(1.5);
    expect(config.mode).toBe('warn');
  });

  test('mode defaults to soft-stop when omitted', () => {
    const config = BudgetConfigSchema.parse({ dailyBudget: 5 });
    expect(config.mode).toBe('soft-stop');
  });

  test('rejects negative dailyBudget', () => {
    expect(() => BudgetConfigSchema.parse({ dailyBudget: -1 })).toThrow();
  });

  test('rejects invalid mode string', () => {
    expect(() => BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'no-way' })).toThrow();
  });

  test('accepts $0 dailyBudget', () => {
    const config = BudgetConfigSchema.parse({ dailyBudget: 0 });
    expect(config.dailyBudget).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// $0 budget edge case
// ---------------------------------------------------------------------------

describe('SPEC-702: $0 budget always blocks', () => {
  test('hard-stop mode with $0 budget → block action', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 0, mode: 'hard-stop' });
    const est = makeEstimate(0.001);
    // $0 budget should block regardless (doesn't throw — handled before mode check)
    const decision = enforcer.check(est, 'ws1', config);
    expect(decision.action).toBe('block');
  });

  test('warn mode with $0 budget → block action', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 0, mode: 'warn' });
    const decision = enforcer.check(makeEstimate(0.001), 'ws1', config);
    expect(decision.action).toBe('block');
  });

  test('free estimate ($0 cost) with $0 budget → block action', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 0, mode: 'soft-stop' });
    const freeEst = makeEstimate(0, 0, 0);
    const decision = enforcer.check(freeEst, 'ws1', config);
    expect(decision.action).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// warn mode
// ---------------------------------------------------------------------------

describe('SPEC-702: warn mode', () => {
  test('under budget → proceed (no banner)', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 10, mode: 'warn' });
    // Very cheap estimate well under budget
    const decision = enforcer.check(makeEstimate(0.001, 0.002), 'ws1', config);
    expect(decision.action).toBe('proceed');
  });

  test('hi-band ≥ $0.20 → warn with banner message', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 100, mode: 'warn' });
    // costHi = $0.25 triggers warn threshold
    const decision = enforcer.check(makeEstimate(0.1, 0.25), 'ws1', config);
    expect(decision.action).toBe('warn');
    expect('message' in decision && decision.message).toBeTruthy();
  });

  test('hi-band exceeds remaining → warn', () => {
    const enforcer = createBudgetEnforcer();
    enforcer.recordSpend(9.5, 'ws1'); // $9.50 already spent
    const config = BudgetConfigSchema.parse({ dailyBudget: 10, mode: 'warn' });
    // Only $0.50 remaining, hi=$0.60 → over
    const decision = enforcer.check(makeEstimate(0.3, 0.6), 'ws1', config);
    expect(decision.action).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// soft-stop mode
// ---------------------------------------------------------------------------

describe('SPEC-702: soft-stop mode', () => {
  test('under budget → proceed', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 10, mode: 'soft-stop' });
    const decision = enforcer.check(makeEstimate(0.001, 0.002), 'ws1', config);
    expect(decision.action).toBe('proceed');
  });

  test('over budget → prompt action with message', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'soft-stop' });
    enforcer.recordSpend(0.95, 'ws1');
    // hi=$0.3 > remaining $0.05
    const decision = enforcer.check(makeEstimate(0.1, 0.3), 'ws1', config);
    expect(decision.action).toBe('prompt');
    expect('message' in decision && decision.message).toContain('Proceed?');
  });
});

// ---------------------------------------------------------------------------
// hard-stop mode
// ---------------------------------------------------------------------------

describe('SPEC-702: hard-stop mode', () => {
  test('under budget → proceed', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 10, mode: 'hard-stop' });
    const decision = enforcer.check(makeEstimate(0.001, 0.002), 'ws1', config);
    expect(decision.action).toBe('proceed');
  });

  test('hi > remaining → throws NimbusError with U_BAD_COMMAND', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'hard-stop' });
    enforcer.recordSpend(0.95, 'ws1');
    expect(() =>
      enforcer.check(makeEstimate(0.1, 0.3), 'ws1', config),
    ).toThrow(NimbusError);
  });

  test('NimbusError has correct code', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 0.01, mode: 'hard-stop' });
    try {
      enforcer.check(makeEstimate(0.1, 0.5), 'ws1', config);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
      expect((err as NimbusError).context['reason']).toBe('budget_hard_stop');
    }
  });
});

// ---------------------------------------------------------------------------
// fallback mode
// ---------------------------------------------------------------------------

describe('SPEC-702: fallback mode', () => {
  test('under budget → proceed', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 10, mode: 'fallback' });
    const decision = enforcer.check(makeEstimate(0.001, 0.002), 'ws1', config);
    expect(decision.action).toBe('proceed');
  });

  test('over budget at flagship → downgrade to workhorse', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'fallback' });
    enforcer.recordSpend(0.9, 'ws1');
    const decision = enforcer.check(makeEstimate(0.2, 0.5), 'ws1', config, 'flagship');
    expect(decision.action).toBe('downgrade');
    expect('newModelClass' in decision && decision.newModelClass).toBe('workhorse');
  });

  test('over budget at workhorse → downgrade to budget', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'fallback' });
    enforcer.recordSpend(0.9, 'ws1');
    const decision = enforcer.check(makeEstimate(0.2, 0.5), 'ws1', config, 'workhorse');
    expect(decision.action).toBe('downgrade');
    expect('newModelClass' in decision && decision.newModelClass).toBe('budget');
  });

  test('fallback exhausted at budget class → soft-stop (prompt)', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'fallback' });
    enforcer.recordSpend(0.9, 'ws1');
    const decision = enforcer.check(makeEstimate(0.2, 0.5), 'ws1', config, 'budget');
    expect(decision.action).toBe('prompt');
  });

  test('fallback downgrade includes informative message', () => {
    const enforcer = createBudgetEnforcer();
    const config = BudgetConfigSchema.parse({ dailyBudget: 1, mode: 'fallback' });
    enforcer.recordSpend(0.8, 'ws1');
    const decision = enforcer.check(makeEstimate(0.3, 0.6), 'ws1', config, 'flagship');
    expect(decision.action).toBe('downgrade');
    expect('message' in decision && decision.message).toContain('flagship');
    expect('message' in decision && decision.message).toContain('workhorse');
  });
});

// ---------------------------------------------------------------------------
// nextModelClass chain
// ---------------------------------------------------------------------------

describe('SPEC-702: nextModelClass', () => {
  test('flagship → workhorse', () => expect(nextModelClass('flagship')).toBe('workhorse'));
  test('workhorse → budget', () => expect(nextModelClass('workhorse')).toBe('budget'));
  test('budget → null (end of chain)', () => expect(nextModelClass('budget')).toBeNull());
  test('reasoning → null (not in downgrade chain)', () => expect(nextModelClass('reasoning')).toBeNull());
  test('local → null', () => expect(nextModelClass('local')).toBeNull());
});

// ---------------------------------------------------------------------------
// recordSpend + getSpent + resetDaily
// ---------------------------------------------------------------------------

describe('SPEC-702: spend tracking', () => {
  test('recordSpend accumulates for same workspace', () => {
    const enforcer = createBudgetEnforcer();
    enforcer.recordSpend(0.1, 'ws1');
    enforcer.recordSpend(0.2, 'ws1');
    expect(enforcer.getSpent('ws1')).toBeCloseTo(0.3, 6);
  });

  test('spend is isolated per workspace', () => {
    const enforcer = createBudgetEnforcer();
    enforcer.recordSpend(0.5, 'ws1');
    enforcer.recordSpend(0.3, 'ws2');
    expect(enforcer.getSpent('ws1')).toBeCloseTo(0.5, 6);
    expect(enforcer.getSpent('ws2')).toBeCloseTo(0.3, 6);
  });

  test('resetDaily clears spend for workspace', () => {
    const enforcer = createBudgetEnforcer();
    enforcer.recordSpend(0.5, 'ws1');
    enforcer.resetDaily('ws1');
    expect(enforcer.getSpent('ws1')).toBe(0);
  });

  test('unknown workspace getSpent returns 0', () => {
    const enforcer = createBudgetEnforcer();
    expect(enforcer.getSpent('ws-never-seen')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /budget slash parser
// ---------------------------------------------------------------------------

describe('SPEC-702: parseBudgetSlash', () => {
  test('/budget $5 parses correctly', () => {
    const result = parseBudgetSlash('/budget $5');
    expect(result.dailyBudget).toBe(5);
    expect(result.mode).toBeNull();
  });

  test('/budget 10.50 (no $) parses correctly', () => {
    const result = parseBudgetSlash('/budget 10.50');
    expect(result.dailyBudget).toBe(10.5);
    expect(result.mode).toBeNull();
  });

  test('/budget $2.00 hard-stop parses mode', () => {
    const result = parseBudgetSlash('/budget $2.00 hard-stop');
    expect(result.dailyBudget).toBe(2.0);
    expect(result.mode).toBe('hard-stop');
  });

  test('/budget $0 fallback — zero budget with mode', () => {
    const result = parseBudgetSlash('/budget $0 fallback');
    expect(result.dailyBudget).toBe(0);
    expect(result.mode).toBe('fallback');
  });

  test('/budget $1 warn — warn mode', () => {
    const result = parseBudgetSlash('/budget $1 warn');
    expect(result.mode).toBe('warn');
  });

  test('/budget $3 soft-stop — soft-stop mode', () => {
    const result = parseBudgetSlash('/budget $3 soft-stop');
    expect(result.mode).toBe('soft-stop');
  });

  test('invalid input throws NimbusError', () => {
    expect(() => parseBudgetSlash('/budget')).toThrow(NimbusError);
    expect(() => parseBudgetSlash('budget 5')).toThrow(NimbusError);
    expect(() => parseBudgetSlash('/budget abc')).toThrow(NimbusError);
  });

  test('invalid input NimbusError has U_BAD_COMMAND code', () => {
    try {
      parseBudgetSlash('/budget');
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });
});
