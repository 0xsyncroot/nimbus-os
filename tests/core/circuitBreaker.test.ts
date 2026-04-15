import { describe, expect, test } from 'bun:test';
import { breakerKey, createBreaker, guardBreaker } from '../../src/core/circuitBreaker.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

function fakeClock(t: { ms: number }) {
  return { now: () => t.ms };
}

describe('SPEC-107: circuit breaker', () => {
  test('2 errors keep closed; 3rd opens', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    expect(b.snapshot(key)).toBe('CLOSED');
    b.record(key, 'P_5XX');
    expect(b.snapshot(key)).toBe('OPEN');
    expect(() => guardBreaker(b, key)).toThrow();
  });

  test('window expiry resets count', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3, windowMs: 60_000 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    t.ms += 61_000;
    b.record(key, 'P_5XX');
    expect(b.snapshot(key)).toBe('CLOSED');
  });

  test('open → half_open after openDuration', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3, openDurationMs: 30_000 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    expect(b.snapshot(key)).toBe('OPEN');
    t.ms += 31_000;
    const c = b.check(key);
    expect(c.state).toBe('HALF_OPEN');
  });

  test('half_open + success → closed', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3, openDurationMs: 30_000 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    t.ms += 31_000;
    b.check(key);
    b.record(key, 'ok');
    expect(b.snapshot(key)).toBe('CLOSED');
  });

  test('half_open + failure → open again', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3, openDurationMs: 30_000 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    t.ms += 31_000;
    b.check(key);
    b.record(key, 'P_5XX');
    expect(b.snapshot(key)).toBe('OPEN');
  });

  test('per-key isolation', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3 }, fakeClock(t));
    const ka = breakerKey('anthropic', 'P_5XX');
    const kb = breakerKey('openai', 'P_5XX');
    b.record(ka, 'P_5XX');
    b.record(ka, 'P_5XX');
    b.record(ka, 'P_5XX');
    expect(b.snapshot(ka)).toBe('OPEN');
    expect(b.snapshot(kb)).toBe('CLOSED');
  });

  test('mixed families don\'t trip', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_429');
    expect(b.snapshot(key)).toBe('CLOSED');
  });

  test('guardBreaker throws Y_CIRCUIT_BREAKER_OPEN', () => {
    const t = { ms: 1000 };
    const b = createBreaker({ threshold: 3 }, fakeClock(t));
    const key = breakerKey('anthropic', 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    b.record(key, 'P_5XX');
    try {
      guardBreaker(b, key);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.Y_CIRCUIT_BREAKER_OPEN);
    }
  });
});
