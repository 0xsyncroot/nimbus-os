// rateLimiter.ts — SPEC-802 T2: token-bucket rate limiter.
// O(1) per call; state held in closure returned by createRateLimiter.
// Used by Telegram/Slack/HTTP adapters without duplicating logic.

export interface RateLimiterHandle {
  /** Consume `tokens` (default 1). Returns waitMs: 0 = send immediately,
   *  >0 = caller should delay by this many milliseconds before proceeding. */
  consume(tokens?: number): number;
}

export interface RateLimiterOpts {
  /** Maximum tokens the bucket can hold (burst capacity). */
  capacity: number;
  /** Tokens added per second (steady-state rate). */
  refillRatePerSec: number;
}

/**
 * Creates a token-bucket rate limiter. The returned handle is NOT thread-safe
 * across concurrent callers — each caller should have its own instance.
 */
export function createRateLimiter(opts: RateLimiterOpts): RateLimiterHandle {
  const { capacity, refillRatePerSec } = opts;
  if (capacity <= 0) throw new RangeError('RateLimiter: capacity must be >0');
  if (refillRatePerSec <= 0) throw new RangeError('RateLimiter: refillRatePerSec must be >0');

  let tokens = capacity;
  let lastRefillMs = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsedSec = (now - lastRefillMs) / 1000;
    tokens = Math.min(capacity, tokens + elapsedSec * refillRatePerSec);
    lastRefillMs = now;
  }

  function consume(n = 1): number {
    refill();
    if (tokens >= n) {
      tokens -= n;
      return 0;
    }
    // How long until we have enough tokens?
    const deficit = n - tokens;
    const waitMs = Math.ceil((deficit / refillRatePerSec) * 1000);
    return waitMs;
  }

  return { consume };
}
