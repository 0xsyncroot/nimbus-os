// circuit.ts — SPEC-602: global circuit breaker for self-heal engine.
// 3 consecutive same-code failures within 60s → open 5min.
// Separate from SPEC-107 circuitBreaker (provider-scoped); this is error-code-scoped.

export interface HealCircuitState {
  errorCode: string;
  consecutiveFailures: number;
  lastFailureAt: number;
  openUntil: number;
}

export interface HealCircuit {
  isOpen(code: string, nowMs?: number): boolean;
  openUntilMs(code: string): number;
  recordFailure(code: string, nowMs?: number): void;
  recordSuccess(code: string): void;
  reset(): void;
}

const WINDOW_MS = 60_000;    // 60s sliding window
const THRESHOLD = 3;          // 3 consecutive failures
const OPEN_DURATION_MS = 5 * 60_000; // 5 min

export function createHealCircuit(): HealCircuit {
  const states = new Map<string, HealCircuitState>();

  function getOrCreate(code: string): HealCircuitState {
    let s = states.get(code);
    if (!s) {
      s = { errorCode: code, consecutiveFailures: 0, lastFailureAt: 0, openUntil: 0 };
      states.set(code, s);
    }
    return s;
  }

  function isOpen(code: string, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const s = states.get(code);
    if (!s) return false;
    return s.openUntil > now;
  }

  function openUntilMs(code: string): number {
    return states.get(code)?.openUntil ?? 0;
  }

  function recordFailure(code: string, nowMs?: number): void {
    const now = nowMs ?? Date.now();
    const s = getOrCreate(code);
    // Reset streak if last failure was outside the window
    if (now - s.lastFailureAt > WINDOW_MS) {
      s.consecutiveFailures = 0;
    }
    s.consecutiveFailures += 1;
    s.lastFailureAt = now;
    if (s.consecutiveFailures >= THRESHOLD && s.openUntil <= now) {
      s.openUntil = now + OPEN_DURATION_MS;
    }
  }

  function recordSuccess(code: string): void {
    const s = states.get(code);
    if (!s) return;
    s.consecutiveFailures = 0;
    s.openUntil = 0;
  }

  function reset(): void {
    states.clear();
  }

  return { isOpen, openUntilMs, recordFailure, recordSuccess, reset };
}

// Module-level singleton for easy use from healers
let _globalCircuit: HealCircuit | null = null;

export function getGlobalHealCircuit(): HealCircuit {
  if (!_globalCircuit) _globalCircuit = createHealCircuit();
  return _globalCircuit;
}

export function __resetHealCircuit(): void {
  _globalCircuit = null;
}
