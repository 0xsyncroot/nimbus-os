---
id: SPEC-107
title: Circuit breaker — 3 consecutive errors pause
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003]
blocks: [SPEC-103]
estimated_loc: 90
files_touched:
  - src/core/circuitBreaker.ts
  - tests/core/circuitBreaker.test.ts
---

# Circuit Breaker

## 1. Outcomes

- 3 consecutive provider errors (same category) within a sliding 60s window → breaker OPEN → subsequent calls throw `NimbusError(Y_CIRCUIT_BREAKER_OPEN, {key, family, retryAfterMs})` for 30s.
- Success resets count (closed state). After 30s open, breaker enters HALF_OPEN: next call is a probe; success → CLOSED, failure → OPEN again.
- Per-key isolation: breaker state keyed by `(providerId, errorFamily)` — Anthropic 5xx failures don't trip OpenAI's breaker.
- Loop (SPEC-103) consults breaker BEFORE every provider call (cost savings + fast-fail); runaway-loop + paid-tokens scenario (T18) blocked.

## 2. Scope

### 2.1 In-scope
- State machine: `CLOSED → OPEN → HALF_OPEN → CLOSED | OPEN`.
- Sliding window counter (60s default).
- Per-key isolation via `Map<string, BreakerState>`.
- `wrapBreaker(key, fn)` helper for providers; `check(key)` for pre-call guards.
- Emits breaker events to observability bus (opened/closed/probe).

### 2.2 Out-of-scope
- Exponential backoff — self-heal engine (v0.2) layers on top.
- Per-tool breaker — v0.2 when tool errors grouped; v0.1 is provider-only.
- Jittered probe → v0.2 (current: deterministic 30s).
- Multi-level (flap detection) → v0.3.

## 3. Constraints

### Technical
- Pure in-memory (no persistence; reset on process restart is fine).
- Thread-safe via single-writer (Bun is single-threaded at module scope).
- Time via injected `now()` clock for testability (no direct `Date.now()` in logic).
- TS strict.

### Performance
- `check(key)` <0.05ms (Map lookup + simple comparisons).
- `record(key, outcome)` <0.05ms.

### Resource
- Map size bounded: LRU evict entries idle >1h; max 1000 keys.

## 4. Prior Decisions

- **3 errors / 60s threshold** — why: empirical from Anthropic observed flap rate; 3 rules out transient single 5xx. Configurable per-key if v0.2 needs it.
- **30s open duration** — why: Anthropic `retry-after` usually 10-30s; 30s absorbs most; doubles as rate-limit circuit-hardening.
- **Per-key `(providerId, errorFamily)`** — why: avoid Anthropic outage tripping local Ollama; avoid 429s (rate limit) tripping 5xx's breaker.
- **Consult pre-call in loop** — why: post-call means we pay one more token-priced call per trip; pre-call is free.
- **Injected clock** — why: tests would be flaky with real `Date.now()`; clean abstraction.
- **In-memory only** — why: cross-process breaker requires daemon (v0.4); v0.1 is single-process CLI.
- **`ErrorFamily` is strict subset of `ErrorCode`** — why not add `P_OTHER`: avoid META-003 churn; `P_INVALID_REQUEST` already covers unclassified provider failures per META-003. Caller maps raw errors via `classify()` before calling `record()`.
- **Breaker-open throws dedicated `Y_CIRCUIT_BREAKER_OPEN`** — why: system-family code (not provider `P_*`) accurately reflects that nimbus itself is refusing the call, not the provider. Added to META-003 (2026-04-15) for clean observability aggregation and distinct self-heal policy (wait retryAfterMs, don't retry-with-backoff blindly).

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | State machine types + `BreakerState` | `CLOSED/OPEN/HALF_OPEN` transitions enumerated; Zod-free (internal) | 20 | — |
| T2 | `check(key)` + `record(key, outcome)` | counts sliding window; transitions correct per spec §1 | 40 | T1 |
| T3 | Injected clock + `now()` wiring | all time reads go through `clock.now()` | 10 | T2 |
| T4 | Event emission on state change | emits `breaker.opened` / `breaker.closed` / `breaker.probe` | 20 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/circuitBreaker.test.ts`:
  - `describe('SPEC-107: circuit breaker')`:
    - 2 errors → CLOSED; 3rd error → OPEN; `check()` throws `NimbusError(Y_CIRCUIT_BREAKER_OPEN, {key, family, retryAfterMs})`.
    - Errors separated by >60s (via fake clock) → window resets; does not trip.
    - OPEN → advance 30s → `check()` returns HALF_OPEN; first call allowed.
    - HALF_OPEN + success → CLOSED; count resets.
    - HALF_OPEN + failure → OPEN again; further 30s wait.
    - Per-key isolation: Anthropic 5xx trips → OpenAI calls unaffected.
    - Mixed error families: 2× P_5XX + 1× P_429 → no trip (different families).
    - LRU eviction: insert 1001 keys → 1001st key evicts oldest-idle; assert order: `keys[0]` (earliest `lastTouched`) is the one gone, not random.

### 6.2 E2E Tests
- Covered via SPEC-103 loop test: inject 3 provider failures → 4th call fails fast with breaker-open, no network hit (asserted via mock).

### 6.3 Performance Budgets
- `check()` + `record()` each <0.05ms via `bun:test` bench (10K iters).

### 6.4 Security Checks
- Breaker event log contains no raw error bodies (just `errorFamily + count`) — avoids leaking secrets via logged 401 responses.
- No unbounded memory growth (LRU cap verified).

## 7. Interfaces

```ts
// circuitBreaker.ts
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

// ErrorFamily = strict subset of META-003 ErrorCode (no new codes introduced).
// Breaker-relevant provider codes only; all others (incl. `P_INVALID_REQUEST`
// for "unclassified provider error") map to this family explicitly by caller.
export type ErrorFamily =
  | 'P_NETWORK'
  | 'P_5XX'
  | 'P_429'
  | 'P_AUTH'
  | 'P_INVALID_REQUEST'   // bucket for otherwise-unclassified provider failures

export interface BreakerConfig {
  threshold: number           // default 3
  windowMs: number            // default 60_000
  openDurationMs: number      // default 30_000
}

export interface Clock { now(): number }

export interface CircuitBreaker {
  check(key: string): { state: BreakerState; retryAfterMs?: number }
  record(key: string, outcome: 'ok' | ErrorFamily): void
  subscribe(cb: (ev: BreakerEvent) => void): Disposable
}

export type BreakerEvent =
  | { type: 'breaker.opened'; key: string; reason: ErrorFamily }
  | { type: 'breaker.closed'; key: string }
  | { type: 'breaker.probe'; key: string; ok: boolean }

export function createBreaker(cfg?: Partial<BreakerConfig>, clock?: Clock): CircuitBreaker

// Helper for composing key
export function breakerKey(providerId: string, family: ErrorFamily): string
```

## 8. Files Touched

- `src/core/circuitBreaker.ts` (new, ~70 LoC)
- `tests/core/circuitBreaker.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Config override per-key (`config.circuitBreaker.overrides`)? Defer to v0.2 when profiling shows single-key tuning is needed.
- [ ] Publish breaker state to `nimbus health` CLI — yes, wire via SPEC-601 subscription (v0.3 CLI).

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
- 2026-04-15 @hiepht: revise — switch breaker-open to dedicated `Y_CIRCUIT_BREAKER_OPEN` (META-003 amend); `ErrorFamily` uses `P_INVALID_REQUEST` instead of `P_OTHER`; deterministic LRU eviction assertion
