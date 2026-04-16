---
id: SPEC-802
title: ChannelAdapter foundation + event bus bridge
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: channels
depends_on: [SPEC-801, SPEC-118, SPEC-103, META-003]
blocks: [SPEC-803, SPEC-804, SPEC-805]
estimated_loc: 150
files_touched:
  - src/channels/ChannelAdapter.ts
  - src/channels/ChannelManager.ts
  - src/channels/common/rateLimiter.ts
  - src/channels/common/outboundQueue.ts
  - tests/channels/manager.test.ts
---

# ChannelAdapter foundation + event bus bridge

## 1. Outcomes

- Uniform `ChannelAdapter` interface contracts all channel implementations (Telegram, Slack, HTTP/WS) to a single shape.
- `ChannelManager` registers, starts, and stops adapters; bridges inbound events to the SPEC-118 `EventBus`.
- `OutboundQueue` serialises outbound message sends per-channel with configurable concurrency and back-pressure.
- `RateLimiter` token-bucket implementation shared by Telegram/Slack/HTTP adapters without duplicating logic.

## 2. Scope

### 2.1 In-scope
- `ChannelAdapter` interface with lifecycle hooks (`start`, `stop`, `send`)
- `nativeFormat` discriminant union: `'ansi' | 'telegram-html' | 'slack-mrkdwn' | 'markdown'`
- `ChannelManager` — register/start/stop all adapters; publish `channel.inbound` events to `EventBus`
- `OutboundQueue` — async FIFO queue with `maxConcurrency=1` per adapter, `maxSize=500` drop-oldest
- `RateLimiter` — token-bucket: `capacity`, `refillRate` (tokens/sec), `consume(n)` returning `waitMs`
- Circuit-breaker integration: re-use SPEC-107 `CircuitBreaker` per adapter instance
- `ChannelEvent` type definitions consumed by SPEC-803/804/805

### 2.2 Out-of-scope
- Telegram adapter wiring → SPEC-803
- Slack adapter wiring → SPEC-804
- HTTP/WS adapter wiring → SPEC-805
- Renderer/formatter logic → each adapter spec owns its `nativeFormat` render
- Multi-workspace routing logic → SPEC-105 prompt backbone; channel passes `workspaceId` only

## 3. Constraints

### Technical
- No `any` types; strict TypeScript
- Max 400 LoC per file
- `OutboundQueue` uses only Bun-native async primitives (no `p-queue` npm package)
- `RateLimiter` stateless per call site; state held in a closure returned by `createRateLimiter(opts)`
- `ChannelManager` is a singleton per process (one EventBus, all adapters share it)

### Performance
- `OutboundQueue.enqueue()` <1ms (non-blocking, returns `Promise<void>`)
- `RateLimiter.consume(1)` <0.1ms

### Resource / Business
- 1 dev part-time
- Zero external deps beyond already-present `pino` + SPEC-107 circuit breaker

## 4. Prior Decisions

- **Token-bucket over sliding-window** — token-bucket is O(1) per call; sliding-window requires storing timestamps; downstream adapters need burst headroom (Telegram allows 30 burst then 1/s)
- **OutboundQueue not a global queue** — per-adapter queue isolates a flaky Slack connection from Telegram; simpler error attribution
- **`nativeFormat` on the adapter not the message** — a channel renders all messages in its own format; mixing formats per-message adds complexity without benefit in v0.3
- **Bridge via EventBus not direct callback** — decouples channel layer from agent loop; consistent with SPEC-118 topology; avoids circular imports

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Define `ChannelAdapter` interface + `ChannelEvent` types | Zod validation passes for inbound event shape | 30 | — |
| T2 | Implement `RateLimiter` (token-bucket) | Unit: `consume` blocks correctly, refill fires on schedule | 30 | — |
| T3 | Implement `OutboundQueue` | Unit: FIFO order preserved; overflow drops oldest; concurrency=1 default | 40 | — |
| T4 | Implement `ChannelManager` | Start/stop all registered adapters; inbound bridged to EventBus | 50 | T1, T2, T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/manager.test.ts`:
  - `register` + `start` → adapter `start()` called
  - `stop` → adapter `stop()` called; queue drained before stop
  - inbound event → `EventBus` receives `channel.inbound` with correct shape
- `RateLimiter`: `consume(capacity+1)` returns positive `waitMs`; after refill `consume(1)` returns 0
- `OutboundQueue`: enqueue 600 items with `maxSize=500` → oldest 100 dropped; order preserved for retained 500

### 6.2 E2E Tests
- Covered implicitly by SPEC-803/804/805 e2e tests (adapter round-trip)

### 6.3 Performance Budgets
- `OutboundQueue.enqueue()` <1ms via `bun:test` bench (1000 iterations)
- `RateLimiter.consume(1)` <0.1ms

### 6.4 Security Checks
- `ChannelEvent.payload` logged with digest only (no raw message body in observability)
- `workspaceId` validated as non-empty string before publishing to EventBus

## 7. Interfaces

```ts
export type NativeFormat = 'ansi' | 'telegram-html' | 'slack-mrkdwn' | 'markdown'

export interface ChannelAdapter {
  readonly id: string           // e.g. 'telegram', 'slack', 'http'
  readonly nativeFormat: NativeFormat
  start(): Promise<void>
  stop(): Promise<void>
  send(workspaceId: string, text: string): Promise<void>
}

export interface ChannelInboundEvent {
  type: 'channel.inbound'
  adapterId: string
  workspaceId: string
  userId: string
  text: string
  raw: unknown                  // adapter-specific native event (opaque to core)
}

export interface RateLimiterHandle {
  consume(tokens?: number): number   // returns waitMs (0 = send immediately)
}
export function createRateLimiter(opts: { capacity: number; refillRatePerSec: number }): RateLimiterHandle

export interface OutboundQueue {
  enqueue(task: () => Promise<void>): Promise<void>
  drain(): Promise<void>
}
export function createOutboundQueue(opts?: { maxSize?: number; maxConcurrency?: number }): OutboundQueue

export interface ChannelManager {
  register(adapter: ChannelAdapter): void
  startAll(): Promise<void>
  stopAll(): Promise<void>
}
export function createChannelManager(bus: EventBus): ChannelManager
```

## 8. Files Touched

- `src/channels/ChannelAdapter.ts` (new, ~30 LoC — interface + event types)
- `src/channels/ChannelManager.ts` (new, ~50 LoC)
- `src/channels/common/rateLimiter.ts` (new, ~30 LoC)
- `src/channels/common/outboundQueue.ts` (new, ~40 LoC)
- `tests/channels/manager.test.ts` (new, ~100 LoC)

## 9. Open Questions

- [ ] Should `OutboundQueue` support priority lanes for high-urgency messages? (defer v0.4)
- [ ] Metrics: expose queue depth via SPEC-601 observability? (v0.3.1)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial for v0.3 sprint
