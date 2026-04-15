// circuitBreaker.ts — SPEC-107: 3 consecutive errors → OPEN → probe → CLOSED|OPEN.
// Per-key isolation; injected clock for testability; LRU bound.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { Disposable } from './events.ts';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type ErrorFamily =
  | 'P_NETWORK'
  | 'P_5XX'
  | 'P_429'
  | 'P_AUTH'
  | 'P_INVALID_REQUEST';

export interface BreakerConfig {
  threshold: number;
  windowMs: number;
  openDurationMs: number;
  maxKeys: number;
  idleEvictMs: number;
}

export interface Clock {
  now(): number;
}

export type BreakerEvent =
  | { type: 'breaker.opened'; key: string; reason: ErrorFamily }
  | { type: 'breaker.closed'; key: string }
  | { type: 'breaker.probe'; key: string; ok: boolean };

export interface CircuitBreaker {
  check(key: string): { state: BreakerState; retryAfterMs?: number };
  record(key: string, outcome: 'ok' | ErrorFamily): void;
  subscribe(cb: (ev: BreakerEvent) => void): Disposable;
  snapshot(key: string): BreakerState;
}

interface KeyState {
  state: BreakerState;
  failures: Array<{ family: ErrorFamily; ts: number }>;
  openedAt: number;
  lastTouched: number;
  lastFamily?: ErrorFamily;
}

const DEFAULT_CFG: BreakerConfig = {
  threshold: 3,
  windowMs: 60_000,
  openDurationMs: 30_000,
  maxKeys: 1000,
  idleEvictMs: 60 * 60 * 1000,
};

export function breakerKey(providerId: string, family: ErrorFamily): string {
  return `${providerId}::${family}`;
}

export function createBreaker(
  cfg?: Partial<BreakerConfig>,
  clock: Clock = { now: () => Date.now() },
): CircuitBreaker {
  const config: BreakerConfig = { ...DEFAULT_CFG, ...cfg };
  const keys = new Map<string, KeyState>();
  const subs = new Set<(ev: BreakerEvent) => void>();

  function emit(ev: BreakerEvent): void {
    for (const cb of subs) {
      try {
        cb(ev);
      } catch {
        // swallow
      }
    }
  }

  function evictIfNeeded(): void {
    if (keys.size <= config.maxKeys) return;
    // Deterministic: evict the entry with smallest lastTouched.
    let oldestKey: string | null = null;
    let oldestTouched = Infinity;
    for (const [k, v] of keys) {
      if (v.lastTouched < oldestTouched) {
        oldestTouched = v.lastTouched;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) keys.delete(oldestKey);
  }

  function touch(key: string): KeyState {
    let s = keys.get(key);
    const now = clock.now();
    if (!s) {
      s = { state: 'CLOSED', failures: [], openedAt: 0, lastTouched: now };
      keys.set(key, s);
      evictIfNeeded();
    } else {
      s.lastTouched = now;
    }
    return s;
  }

  function check(key: string): { state: BreakerState; retryAfterMs?: number } {
    const s = touch(key);
    if (s.state === 'OPEN') {
      const elapsed = clock.now() - s.openedAt;
      if (elapsed >= config.openDurationMs) {
        s.state = 'HALF_OPEN';
        emit({ type: 'breaker.probe', key, ok: false });
        return { state: 'HALF_OPEN' };
      }
      return { state: 'OPEN', retryAfterMs: Math.max(0, config.openDurationMs - elapsed) };
    }
    return { state: s.state };
  }

  function record(key: string, outcome: 'ok' | ErrorFamily): void {
    const s = touch(key);
    const now = clock.now();
    if (outcome === 'ok') {
      const prev = s.state;
      s.failures = [];
      s.state = 'CLOSED';
      s.openedAt = 0;
      if (prev !== 'CLOSED') {
        emit({ type: 'breaker.closed', key });
        if (prev === 'HALF_OPEN') emit({ type: 'breaker.probe', key, ok: true });
      }
      return;
    }
    // Failure.
    if (s.state === 'HALF_OPEN') {
      s.state = 'OPEN';
      s.openedAt = now;
      s.lastFamily = outcome;
      emit({ type: 'breaker.probe', key, ok: false });
      emit({ type: 'breaker.opened', key, reason: outcome });
      return;
    }
    // Prune failures outside sliding window; keep only same-family to avoid cross-family trip.
    s.failures = s.failures.filter(
      (f) => f.family === outcome && now - f.ts <= config.windowMs,
    );
    s.failures.push({ family: outcome, ts: now });
    s.lastFamily = outcome;
    if (s.failures.length >= config.threshold && s.state !== 'OPEN') {
      s.state = 'OPEN';
      s.openedAt = now;
      emit({ type: 'breaker.opened', key, reason: outcome });
    }
  }

  function subscribe(cb: (ev: BreakerEvent) => void): Disposable {
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }

  function snapshot(key: string): BreakerState {
    return keys.get(key)?.state ?? 'CLOSED';
  }

  return { check, record, subscribe, snapshot };
}

/**
 * Caller guard: throws Y_CIRCUIT_BREAKER_OPEN if the breaker is OPEN.
 * Returns the observed state (CLOSED or HALF_OPEN).
 */
export function guardBreaker(breaker: CircuitBreaker, key: string): BreakerState {
  const res = breaker.check(key);
  if (res.state === 'OPEN') {
    throw new NimbusError(ErrorCode.Y_CIRCUIT_BREAKER_OPEN, {
      key,
      retryAfterMs: res.retryAfterMs ?? 0,
    });
  }
  return res.state;
}
