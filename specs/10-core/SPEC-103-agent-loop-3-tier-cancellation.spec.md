---
id: SPEC-103
title: Agent loop + 3-tier cancellation
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-004, SPEC-151, SPEC-201, SPEC-301]
blocks: [SPEC-801, SPEC-107]
estimated_loc: 280
files_touched:
  - src/core/loop.ts
  - src/core/cancellation.ts
  - src/core/turn.ts
  - tests/core/loop.test.ts
  - tests/core/cancellation.test.ts
---

# Agent Loop + 3-tier Cancellation

## 1. Outcomes

- One `runTurn(input, ctx)` async generator yields `CanonicalChunk` + `ToolLifecycle` events as they happen — channels (CLI/WS) can render streaming token-by-token.
- Cancellation at 3 tiers (turn / tool / provider stream) — pressing Ctrl-C mid-tool kills the tool subprocess but keeps the session alive; pressing twice kills the whole turn; third time exits the REPL.
- Loop partitions tool_use blocks: concurrent (read-only) executed via `Promise.all`; serial (write/shell) one at a time — matches Claude Code pattern (`toolOrchestration.ts`).
- Max 30 tool iterations per turn; exceed → abort turn with `NimbusError(T_ITERATION_CAP, {iterations, max})` — guard against runaway agent (T18 in META-009). Uses dedicated `T_ITERATION_CAP` from META-003 (added 2026-04-15) for clean observability aggregation.

## 2. Scope

### 2.1 In-scope
- `runTurn()` async generator: build prompt → call provider → process chunks → execute tools → loop.
- `AbortController` tree: `turnAbort > toolAbort > providerAbort` (parent abort propagates).
- `onSigint()` handler (from SPEC-151) wired to cancellation escalation (count-based).
- Tool partition: read `Tool.sideEffects` metadata (from SPEC-301) → group; concurrent for `pure|read`, serial for `write|exec`.
- Turn metric emission at completion (hook for SPEC-601 observability).

### 2.2 Out-of-scope
- Context compact/micro-compact → v0.2.
- Skill activation → v0.2.
- Sub-agent spawn → v0.3.
- Plan detector → v0.2.
- Environment block injection (git/mailbox) → v0.2 (see SPEC-105 §2 OOS).

## 3. Constraints

### Technical
- Bun ≥1.2 with native `AbortSignal.any([...])`.
- Generator, not callback-based (streaming to channels via `for await`).
- Every long-running op (provider stream, tool exec) accepts `AbortSignal` and honors within 100ms.
- Throws only `NimbusError`. Unhandled `Error` → `classify()` → `T_CRASH`.
- Circuit breaker (SPEC-107) consulted before each provider call; on-open → throw `Y_CIRCUIT_BREAKER_OPEN` with `retryAfterMs`.

### Performance
- First token latency <1s (provider-dependent, measured end-to-end excluding network).
- Cancellation latency <100ms (from abort to cleanup complete).
- Tool partition decision <1ms.

### Resource
- Max 30 tool iterations per turn (`MAX_TOOL_ITERATIONS`).
- No memory leak on cancel: every `setTimeout` / `setInterval` registered through `signal`-aware helpers.

## 4. Prior Decisions

- **3-tier abort tree** — why not single-level: user needs granularity ("kill this slow tool but finish the turn"). Reference Claude Code `query.ts:219-1520`.
- **Count-based Ctrl-C escalation** — why not menu: hard interrupt UX must be fast; 1/2/3 maps to tool/turn/exit intuitively.
- **Generator output, not events** — why: `for await` pattern composes with channel backpressure naturally; event-emitter needs separate cleanup.
- **Serial execution for write tools** — why: concurrent writes risk `.bashrc`/same-file races; v0.1 conservative. v0.2 could allow parallel via file-lock pool.
- **Cap at 30 iterations** — why: empirical; infinite-retry bugs observed in pilots cost real money (T18). Escape via explicit user `/continue` in v0.2.
- **Circuit breaker checked pre-call** — why: avoid adding failed call to error-count loop; fail fast.
- **Dedicated `T_ITERATION_CAP` code** — why: added to META-003 (2026-04-15) so observability aggregates runaway-agent incidents separately from genuine tool timeouts (`T_TIMEOUT`). Cleaner than shared-code + `reason` discriminator.
- **Tool partition reads `Tool.sideEffects: 'pure'|'read'|'write'|'exec'` from SPEC-301** — why: single source of truth for partition rules; any new tool declares its effect, no central list to maintain.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `cancellation.ts`: 3-tier `AbortController` tree | `createTurnAbort()` returns `{turn, tool, provider}`; parent abort propagates within 10ms | 60 | — |
| T2 | SIGINT escalation logic | 1st ctrl-c → tool abort; 2nd within 1.5s → turn abort; 3rd → `process.exit(0)` | 30 | T1 |
| T3 | `runTurn()` generator skeleton | builds prompt via SPEC-105 stub, streams chunks, yields via generator | 80 | T1 |
| T4 | Tool partition + execute | `pure|read` concurrent via `Promise.all`; `write|exec` serial; respects `toolAbort` | 60 | T3 |
| T5 | Iteration cap + circuit breaker | on >30 iter → `T_ITERATION_CAP`; on breaker-open → `Y_CIRCUIT_BREAKER_OPEN` with `retryAfterMs` | 30 | T3 |
| T6 | TurnMetric emission | emits final metric to observability bus on `try/finally` (success + abort) | 20 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/cancellation.test.ts`:
  - `describe('SPEC-103: 3-tier abort')`:
    - Parent abort propagates to child within 10ms.
    - Aborting child does NOT abort siblings.
    - Disposable cleanup runs exactly once even on double-abort.
- `tests/core/loop.test.ts`:
  - `describe('SPEC-103: runTurn')`:
    - 3 concurrent Read tool_uses → executed in parallel (measured total time < 1.1× single).
    - 1 Read + 1 Write → Read finishes, Write starts after (serial for write).
    - 31st iteration → throws `NimbusError(T_ITERATION_CAP, {iterations: 31, max: 30})`.
    - Abort mid-stream: loop exits within 100ms; `TurnMetric.outcome === 'cancelled'` (aligned with SPEC-601 TurnMetricSchema enum `['ok','error','cancelled']`).
    - Provider throws `P_429` → single retry with `retry-after`.
  - SIGINT escalation:
    - 1 press → tool abort only; session continues.
    - 2 presses within 1.5s → turn abort; message reads "cancelled".
    - 3 presses → process exits.

### 6.2 E2E Tests
- `tests/e2e/loop-cancel.test.ts`: REPL mid-response + Ctrl-C twice → REPL returns to prompt within 200ms.

### 6.3 Performance Budgets
- First token latency <1s (provider mocked, measures overhead only: <50ms overhead).
- Cancellation latency <100ms (abort → cleanup done).

### 6.4 Security Checks
- Bail on `ErrorCode.X_*` (security) without retry — verified via test where tool gate throws `X_BASH_BLOCKED` → no retry attempt.
- Aborted tool subprocess: assert no zombie Bun child process after turn end.
- Circuit breaker consulted on EVERY provider call (not cached-past).

## 7. Interfaces

```ts
// cancellation.ts
export interface TurnAbort {
  turn: AbortController
  tool: AbortController             // child of turn
  provider: AbortController         // child of turn
  dispose(): void
}
export function createTurnAbort(parent?: AbortSignal): TurnAbort

// turn.ts
export interface TurnContext {
  sessionId: string
  wsId: string
  channel: 'cli' | 'http' | 'ws' | 'telegram' | 'slack'   // canonical set from SPEC-601
  mode: 'readonly' | 'default' | 'bypass'
  abort: TurnAbort
}

export type LoopOutput =
  | { kind: 'chunk'; chunk: CanonicalChunk }
  | { kind: 'tool_start'; toolUseId: string; name: string }
  | { kind: 'tool_end'; toolUseId: string; ok: boolean; ms: number }
  | { kind: 'turn_end'; metric: TurnMetric }

// loop.ts
export async function* runTurn(
  input: string,
  ctx: TurnContext,
): AsyncGenerator<LoopOutput, void, void>

// Constants
// TODO v0.2: move MAX_TOOL_ITERATIONS to config (SPEC-501); v0.1 hard-coded intentionally.
export const MAX_TOOL_ITERATIONS = 30
export const CANCEL_ESCALATION_WINDOW_MS = 1500
```

## 8. Files Touched

- `src/core/loop.ts` (new, ~180 LoC)
- `src/core/cancellation.ts` (new, ~60 LoC)
- `src/core/turn.ts` (new, ~40 LoC — types only)
- `tests/core/loop.test.ts` (new, ~200 LoC)
- `tests/core/cancellation.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Escalation window duration: 1.5s feels tight on slow terminals. Benchmark in v0.2 UX pass.
- [ ] Should iteration cap be user-configurable via `config.json`? Default fixed 30; revisit v0.2 after observing usage.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
- 2026-04-15 @hiepht: revise — align `TurnMetric.outcome='cancelled'` with SPEC-601; add `'ws'` channel; switch iteration cap to `T_ITERATION_CAP` and breaker-open to `Y_CIRCUIT_BREAKER_OPEN` (both added to META-003)
