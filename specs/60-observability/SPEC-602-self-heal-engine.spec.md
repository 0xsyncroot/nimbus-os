---
id: SPEC-602
title: Self-heal engine + policy matrix + 4 healers
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: observability
depends_on: [SPEC-601, SPEC-107, SPEC-103, META-003, META-009]
blocks: []
estimated_loc: 300
files_touched:
  - src/selfHeal/engine.ts
  - src/selfHeal/circuit.ts
  - src/selfHeal/healers/provider.ts
  - src/selfHeal/healers/tool.ts
  - src/selfHeal/healers/storage.ts
  - src/selfHeal/healers/subsystem.ts
  - tests/selfHeal/engine.test.ts
  - tests/selfHeal/healers.test.ts
---

# Self-heal engine — deterministic recovery policies per ErrorCode

## 1. Outcomes

- Transient provider/tool/storage errors auto-recover without user intervention (retry/compact/fallback)
- Security errors (X_*) NEVER auto-recover — always escalate + SecurityEvent
- Per-turn state prevents cross-turn pollution; global circuit breaker prevents retry storms
- User sees appropriate notification level (silent/toast/banner/loud) per policy

## 2. Scope

### 2.1 In-scope

- `SelfHealEngine.handle(err, {turnId})` — classify, check security gate, dispatch to healer, return action
- State machine per `(turnId, errorCode)`: `{attempts, lastAttemptAt, circuitState}`
- Circuit breaker: 3 consecutive failures (same code, any turn within 60s) → open 5min
- 4 healers:
  - `healProvider` (P_*): retry with exp backoff, 429 honor retry-after, model switch after 2 fails
  - `healTool` (T_*, U_*): retry 1-2x, feed-to-llm on crash
  - `healStorage` (S_*): restoreFromBackup, smaller compact window
  - `healSubsystem` (Y_*): daemon restart, OOM escalate, disk-full auto-prune logs >30d
- Security gate: `X_*` prefix → escalate immediately, no state write
- Full policy matrix per plan §11 (15 ErrorCodes mapped)

### 2.2 Out-of-scope

- LLM-powered diagnose (SPEC-603 dashboard wrapper)
- FixSkill auto-apply (v0.3.1 — requires user confirm)
- Cross-process heal (v0.4 daemon)

## 3. Constraints

### Technical
- Bun-native, TS strict, no `any`, max 400 LoC per file
- State keyed by `turnId:errorCode` — NEVER cross-turn pollution
- Global circuit keyed by errorCode only

### Security
- `X_*` code branch MUST be before healer dispatch — no retry ever
- SecurityEvent logged on every X_* escalation
- Healers MUST NOT modify SOUL.md / IDENTITY.md / security layer

### Performance
- `handle()` <5ms (no LLM call, pure state machine)
- Healers run on retry path — budget per error class

## 4. Prior Decisions

- **X_* errors NEVER auto-recover** — audit break if retry; always escalate + SecurityEvent (META-009 hard requirement)
- **Y_DISK_FULL fails open to stderr** — logger never blocks writes, auto-prune logs >30d, never prune audit log
- **State keyed by turnId** — cross-turn pollution is the classic anti-pattern; circuit breaker is the only global and only opens (never silently closes + retries)
- **P_AUTH is loud-escalate, 0 retries** — retrying risks account lockout + credential leak across provider swaps
- **Feed-to-LLM on T_CRASH** — let model choose alternative tool; deterministic fallback
- **Backoff jitter** — full random jitter to prevent thundering herd when multiple turns fail simultaneously
- **Separate healers per subsystem** — keeps policy matrix readable, tests isolated

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | `SelfHealEngine.handle()` + state map + security gate | X_* → escalate immediately, no state write | 60 | — |
| T2 | `circuit.ts` — 3-strike breaker, 5min open | 3 failures → open, 4th → escalate | 40 | — |
| T3 | `healProvider.ts` — P_NETWORK/P_5XX/P_429/P_AUTH/P_CONTEXT_OVERFLOW | 5 policies tested | 70 | T1 |
| T4 | `healTool.ts` — T_TIMEOUT/T_CRASH/T_VALIDATION/T_PERMISSION | 4 policies tested | 50 | T1 |
| T5 | `healStorage.ts` — S_STORAGE_CORRUPT/S_COMPACT_FAIL/S_SOUL_PARSE | 3 policies tested | 40 | T1 |
| T6 | `healSubsystem.ts` — Y_OOM/Y_DISK_FULL/Y_SUBAGENT_CRASH/Y_DAEMON_CRASH | 4 policies tested | 40 | T1 |

## 6. Verification

### 6.1 Unit Tests
- Per-ErrorCode policy: assert action + attempts + notify
- Circuit breaker: 3 failures open, 4th escalates
- Security gate: X_* bypasses all healers
- Cross-turn: turnA error → turnB same code → isolated state

### 6.2 E2E Tests
- Chaos test: simulate P_NETWORK 5x in one turn → retry 3x, escalate 4th
- P_CONTEXT_OVERFLOW → engine forces `/compact` → next attempt succeeds

### 6.3 Security Checks
- X_BASH_BLOCKED → escalate immediately, SecurityEvent written, attempts never incremented
- Y_DISK_FULL → logger falls back to stderr, audit log preserved

## 7. Interfaces

```ts
interface HealState {
  errorCode: ErrorCode;
  attempts: number;
  lastAttemptAt: number;
  circuitState: 'closed' | 'open' | 'half-open';
  openedUntil?: number;
}

interface HealDecision {
  action: 'retry' | 'feed-to-llm' | 'escalate' | 'compact-then-retry' | 'switch-model';
  delayMs?: number;
  notify: 'silent' | 'toast' | 'banner' | 'loud';
  message?: string;
  newModel?: string;    // for switch-model
}

interface SelfHealEngine {
  handle(err: NimbusError, ctx: { turnId: string }): Promise<HealDecision>;
  resetTurn(turnId: string): void;
}
```

## 8. Files Touched

- `src/selfHeal/engine.ts` (new, ~60 LoC)
- `src/selfHeal/circuit.ts` (new, ~40 LoC)
- `src/selfHeal/healers/provider.ts` (new, ~70 LoC)
- `src/selfHeal/healers/tool.ts` (new, ~50 LoC)
- `src/selfHeal/healers/storage.ts` (new, ~40 LoC)
- `src/selfHeal/healers/subsystem.ts` (new, ~40 LoC)
- `tests/selfHeal/engine.test.ts` (new, ~80 LoC)
- `tests/selfHeal/healers.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Circuit breaker scope: global or per-workspace? (global for v0.3 — simpler; per-workspace v0.4)

## 10. Changelog

- 2026-04-16 @hiepht: draft — Phase 1 self-heal analyst report, full policy matrix per plan §11
