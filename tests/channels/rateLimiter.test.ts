import { describe, test, expect } from 'bun:test';
import { createRateLimiter } from '../../src/channels/common/rateLimiter.ts';

describe('SPEC-802: RateLimiter (token-bucket)', () => {
  test('consume within capacity returns 0 waitMs', () => {
    const rl = createRateLimiter({ capacity: 10, refillRatePerSec: 1 });
    expect(rl.consume(1)).toBe(0);
    expect(rl.consume(5)).toBe(0);
  });

  test('consume(capacity+1) on fresh bucket returns positive waitMs', () => {
    const rl = createRateLimiter({ capacity: 5, refillRatePerSec: 1 });
    // drain all tokens
    rl.consume(5);
    const waitMs = rl.consume(1);
    expect(waitMs).toBeGreaterThan(0);
  });

  test('consume(1) <0.1ms (performance budget)', () => {
    const rl = createRateLimiter({ capacity: 100, refillRatePerSec: 100 });
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      rl.consume(1);
    }
    const avgMs = (performance.now() - start) / 1000;
    expect(avgMs).toBeLessThan(0.1);
  });

  test('multiple consume calls exactly at capacity all return 0', () => {
    const rl = createRateLimiter({ capacity: 10, refillRatePerSec: 1 });
    for (let i = 0; i < 10; i++) {
      expect(rl.consume(1)).toBe(0);
    }
    // 11th should fail
    expect(rl.consume(1)).toBeGreaterThan(0);
  });

  test('invalid capacity throws', () => {
    expect(() => createRateLimiter({ capacity: 0, refillRatePerSec: 1 })).toThrow(RangeError);
  });

  test('invalid refillRate throws', () => {
    expect(() => createRateLimiter({ capacity: 10, refillRatePerSec: 0 })).toThrow(RangeError);
  });

  test('default token count is 1 when omitted', () => {
    const rl = createRateLimiter({ capacity: 1, refillRatePerSec: 1 });
    expect(rl.consume()).toBe(0);
    expect(rl.consume()).toBeGreaterThan(0);
  });
});
