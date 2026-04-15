---
id: SPEC-118
title: Event bus contract — in-process pub/sub with backpressure
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003]
blocks: [SPEC-102, SPEC-103, SPEC-801]
estimated_loc: 100
files_touched:
  - src/core/events.ts
  - src/core/eventTypes.ts
  - tests/core/events.test.ts
---

# Event Bus Contract

## 1. Outcomes

- Single in-process `EventBus` instance used by SPEC-103 loop, SPEC-102 session store, SPEC-801 CLI REPL — `subscribe(topic, cb)` / `publish(topic, event)` / disposable handle for cleanup.
- Per-subscriber bounded queue (default 1000 events) with **drop-oldest** policy — a slow channel never blocks the producer (e.g., CLI stuck waiting for user input won't stall the agent loop).
- Drop events emit `bus.overflow` system event (observability) with `{topic, subscriberId, droppedCount}` — visible but doesn't crash.
- Closed topics: `session.*` for turn-scoped events, `tool.*` for tool lifecycle, `breaker.*` (from SPEC-107), `bus.*` for bus internal — topic strings are const-exported, not free-form.

## 2. Scope

### 2.1 In-scope
- `createEventBus()` factory; one bus per process (SPEC-103 owns singleton).
- `SessionEvent` union: `user_msg`, `assistant_msg`, `tool_use`, `tool_result`, `turn_complete`, `error`.
- `ToolEvent` union: `tool.start`, `tool.end`.
- Per-subscriber bounded queue, async delivery (microtask scheduled via `queueMicrotask`).
- Unsubscribe via returned `Disposable`; cleanup drains pending events to the callback before release.
- Topic const namespace: `TOPICS.session.userMsg = 'session.user_msg'`, etc.

### 2.2 Out-of-scope
- Cross-process / IPC event bus → v0.4 (daemon).
- Persistent log → SPEC-102 owns `events.jsonl`; bus is ephemeral.
- Topic wildcards + typed per-topic subscriptions + replay cursor → v0.2-v0.3.

## 3. Constraints

### Technical
- Pure TS, zero Bun-specific (can run in mobile client reuse if needed post-v1.0).
- TS strict, no `any`. `publish` typed as `unknown` payload; consumers narrow via topic + discriminator.
- All throws `NimbusError(U_BAD_COMMAND, ctx)` — only on misuse (publishing to non-registered topic).
- Single-threaded safe (Bun module scope); no locks needed.
- Queue overflow MUST be silent-safe (no throw); emits `bus.overflow` for observability.

### Performance
- `publish()` <0.01ms when 0 subscribers (common case for obscure topics).
- `publish()` <0.05ms with 10 subscribers.
- Subscriber delivery latency <1ms from publish to callback invocation (microtask).

### Resource
- Per-subscriber queue cap: 1000 events (configurable via `subscribe(topic, cb, {maxQueue})`).
- Total subscribers bounded: 100 (reject 101st with `U_BAD_COMMAND` — indicates leak).

## 4. Prior Decisions

- **Bounded queue + drop-oldest** — why: stalled subscribers must not OOM the process; newest events are more useful for observability.
- **In-process only for v0.1** — why: daemon (v0.4) adds IPC over same contract; v0.1 CLI is single-process.
- **Const topic namespace** — why: typo-proof + grep-friendly; free-form strings cause silent-drop bugs.
- **Microtask delivery, not sync** — why: sync re-enters producer stack; slow subscriber would block `publish`.
- **Single instance** — why: cross-feature events (breaker→loop→CLI) work naturally; multi-bus adds routing surface with no v0.1 use case.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `eventTypes.ts`: `SessionEvent` + `ToolEvent` unions + `TOPICS` const | discriminated unions; `TOPICS` frozen | 30 | — |
| T2 | `createEventBus()` + internal state | `Map<topic, Set<Subscriber>>`; subscriber counter | 20 | T1 |
| T3 | `subscribe()` + `Disposable` | returns handle; dispose drains queue then removes | 20 | T2 |
| T4 | `publish()` with microtask delivery + bounded queue | drops oldest on overflow; emits `bus.overflow` | 30 | T2 |
| T5 | Topic registration guard | publish to unregistered topic → throw `U_BAD_COMMAND` | 10 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/events.test.ts`:
  - `describe('SPEC-118: event bus')`:
    - Subscribe + publish + receive (happy path).
    - Multiple subscribers same topic: all receive.
    - Subscribers across topics: isolation (A topic publish does NOT wake B subscribers).
    - Dispose: subsequent publish doesn't call the disposed callback.
    - Dispose drains: pending queued events delivered before cleanup.
    - Overflow: publish 1001 events to slow subscriber (callback `await new Promise`) → 1st event dropped, `bus.overflow` emitted with `droppedCount: 1, topic, subscriberId`.
    - Unregistered topic publish → throws `NimbusError(U_BAD_COMMAND, {topic})`.
    - 101st subscriber → throws `NimbusError(U_BAD_COMMAND, {reason: 'max_subscribers'})`.
    - Microtask delivery: synchronous `publish()` returns before callback; observed via ordering test.

### 6.2 E2E Tests
- Covered via SPEC-103 loop test (bus propagates `session.turn_complete` to CLI subscriber which prints to stdout).

### 6.3 Performance Budgets
- `publish()` no-subscriber case <0.01ms (bench 10K iters).
- `publish()` 10-subscriber case <0.05ms.

### 6.4 Security Checks
- Topic strings are code-const, not from user input — no injection.
- Callback errors caught: subscriber throwing doesn't crash bus; error emitted as `bus.subscriber_error` event with `{topic, error: code}` (no raw stack — secret-safe).
- No unbounded memory: verified via 100K-publish test with slow subscriber — heap growth ≤ queue cap × avg event size + constant.

## 7. Interfaces

```ts
// eventTypes.ts
export const TOPICS = Object.freeze({
  session: {
    userMsg: 'session.user_msg',
    assistantMsg: 'session.assistant_msg',
    toolUse: 'session.tool_use',
    toolResult: 'session.tool_result',
    turnComplete: 'session.turn_complete',
    error: 'session.error',
  },
  tool: {
    start: 'tool.start',
    end: 'tool.end',
  },
  breaker: {
    opened: 'breaker.opened',
    closed: 'breaker.closed',
    probe: 'breaker.probe',
  },
  bus: {
    overflow: 'bus.overflow',
    subscriberError: 'bus.subscriber_error',
  },
} as const)

export type SessionEvent =
  | { type: 'session.user_msg'; sessionId: string; text: string; ts: number }
  | { type: 'session.assistant_msg'; sessionId: string; turnId: string; text: string; ts: number }
  | { type: 'session.tool_use'; sessionId: string; turnId: string; toolUseId: string; name: string; ts: number }
  | { type: 'session.tool_result'; sessionId: string; turnId: string; toolUseId: string; ok: boolean; ts: number }
  | { type: 'session.turn_complete'; sessionId: string; turnId: string; ok: boolean; ms: number }
  | { type: 'session.error'; sessionId: string; code: string; ts: number }

// events.ts
export type Disposable = () => void

export interface Subscription {
  id: number
  topic: string
}

export interface EventBus {
  subscribe<T = unknown>(
    topic: string,
    cb: (event: T) => void | Promise<void>,
    opts?: { maxQueue?: number },
  ): Disposable
  publish(topic: string, event: unknown): void   // sync return; delivery is microtask
  size(): { topics: number; subscribers: number }   // diag
}

export function createEventBus(): EventBus
export const DEFAULT_QUEUE_SIZE = 1000
export const MAX_SUBSCRIBERS = 100
```

## 8. Files Touched

- `src/core/events.ts` (new, ~80 LoC)
- `src/core/eventTypes.ts` (new, ~50 LoC)
- `tests/core/events.test.ts` (new, ~180 LoC)

## 9. Open Questions

- [ ] Should per-subscriber queue size be observable (`bus.queue_depth` event every N publishes)? Defer to v0.3 observability.
- [ ] Event timestamp source — bus-assigned via `Clock.now()` or producer-assigned? v0.1: producer assigns (more accurate to actual occurrence); bus never mutates.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
