---
id: SPEC-806
title: Gateway event-fanout hub with session cursor replay
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: channels
depends_on: [SPEC-118, SPEC-802, SPEC-805]
blocks: [SPEC-807]
estimated_loc: 380
files_touched:
  - src/channels/gateway/fanout.ts
  - src/channels/gateway/sessionLog.ts
  - src/channels/gateway/cursor.ts
  - src/channels/http/wsStream.ts
  - tests/channels/gateway/fanout.test.ts
  - tests/channels/gateway/sessionLog.test.ts
---

# Gateway event-fanout hub with session cursor replay

## 1. Outcomes

- Every `session.*` event is appended to `~/.nimbus/sessions/<sessionId>.log` as JSONL with a monotonic `u64` `eventId`.
- Any channel adapter subscribes via `subscribe(sessionId, fromEventId?)` and receives replay of past events followed by live stream.
- Cross-channel echo works: a user message received on Telegram is visible in a parallel HTTP/WS client and future Web UI within 500 ms.
- Clients that disconnect and reconnect with `last-event-id` receive all missed events with no gaps.

## 2. Scope

### 2.1 In-scope

- Append-only JSONL log writer (`sessionLog.ts`) with `mode 0600` per file
- Monotonic `eventId` (bigint serialised as string for JSON safety); on restart, seed from last `eventId` in log
- `subscribe(sessionId, fromEventId?, onEvent)` API returning an unsubscribe function
- Reconnect replay: default last 200 events when `fromEventId` is undefined; exact cursor replay when provided
- Fanout router (`fanout.ts`): bridges `core/events.ts` in-process EventBus → per-session log write + push to live WS subscriber callbacks
- Cursor helpers (`cursor.ts`): parse/compare/advance bigint cursor strings
- Max 32 concurrent subscribers per session (33rd `subscribe` call throws `NimbusError(ErrorCode.C_RESOURCE_LIMIT)`)
- `wsStream.ts` integration: emit `SessionEvent` frames to WS clients via existing SPEC-805 upgrade path

### 2.2 Out-of-scope (v0.4+)

- Session branching (OpenClaw pattern; deferred)
- Multi-workspace cross-account routing
- Redis clustering or distributed fanout

## 3. Constraints

### Technical
- Bun-native only; no Redis, no external message broker, no `EventEmitter` from Node
- `eventId` is `bigint` internally; serialised as decimal string in JSONL (`"eventId": "1234"`) for JSON safety
- fsync batching: flush every 100 ms OR every 16 appended events (whichever comes first), per SPEC-131 pattern
- Per-session log file created with `mode 0600`; directory `~/.nimbus/sessions/` created with `mode 0700`
- Concurrent subscribers per session ≤ 32; enforce in `subscribe()`
- Strict TypeScript; no `any`; max 400 LoC per file

### Performance
- Append throughput: ≥1 000 events/sec sustained (single session)
- Replay of 1 000 events: <50 ms (cold file read)
- Fanout to 32 subscribers: <5 ms per event

### Security
- Log files never contain raw bearer tokens or secrets; `SessionEvent.payload` logged with same SPEC-601 sanitisation rules
- `sessionId` validated as non-empty alphanumeric string before any file path construction (path-traversal guard)

## 4. Prior Decisions

- **File-based + in-process bus over Redis** — nimbus is single-user local-first. Redis adds an ops dependency and daemon requirement. OpenClaw documents Redis as optional for distributed deployments; nimbus zero-dep stays with append-only file log.
- **Monotonic u64 eventId (not UUID)** — matches Claude Code's internal event ordering pattern; enables trivial range queries by comparing integers. Seeded from last line of log on restart so eventId never resets.
- **Cursor-based resume not full replay** — clients send `last-event-id`; server replays from that cursor forward. Matches OpenClaw's `events.jsonl` monotonic ID pattern. Avoids unbounded memory when session logs grow large.
- **In-process bus → fanout → log + WS** — single write path; fanout is the only place that touches the log file for a session, preventing interleaved writes. No duplicate serialisation.
- **Bigint serialised as string** — `JSON.stringify(bigint)` throws in JS; decimal string round-trips losslessly and is lexicographically sortable for the cursor range comparisons in `cursor.ts`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `sessionLog.ts`: append-only JSONL writer with fsync batching | Unit: append → readFrom returns event in order; `eventId` monotonic across restarts (mock restart); file mode 0600 | 90 | — |
| T2 | `cursor.ts`: cursor parse/compare/advance helpers | Unit: `cursorGt`, `cursorNext`, `parseCursor` round-trip; invalid string throws | 40 | — |
| T3 | `fanout.ts`: subscribe + live push + ≤32 limit | Unit: 2 subscribers both receive event; 33rd subscribe throws; unsubscribe fn removes from set | 70 | T1, T2 |
| T4 | Fanout router: EventBus bridge → log write + subscriber push | Integration: EventBus `session.*` event → log appended + both mock subscribers called within 5 ms | 80 | T3 |
| T5 | `wsStream.ts` integration: replay on WS upgrade with `last-event-id` | E2E: connect with cursor → receive replay then live frames; reconnect after disconnect → no gap | 100 | T4 |

## 6. Verification

### 6.1 Unit Tests (`tests/channels/gateway/`)

- `sessionLog.test.ts`:
  - Append 5 events → `readFrom(undefined)` returns all 5 in order
  - `readFrom(eventId=3)` returns events 4 and 5 only
  - `eventId` is strictly monotonic; seeded from last log line after simulated restart
  - File created with mode `0600`
  - Invalid `sessionId` with path separator throws `NimbusError`
- `fanout.test.ts`:
  - `subscribe` + `publish` → callback fires with correct `SessionEvent`
  - Two subscribers on same session both fire
  - Unsubscribe fn removes callback; subsequent publish does not fire
  - 33rd concurrent subscriber throws `NimbusError(ErrorCode.C_RESOURCE_LIMIT)`
  - Replay on `subscribe(sessionId, fromEventId)` emits historical events before live ones

### 6.2 E2E Tests

- `tests/e2e/fanout-replay.test.ts`: spin up two WS clients on the same session; publish 10 events; assert both receive all 10. Kill client 1 at event 5; reconnect with `last-event-id=5`; assert it receives events 6–10 with no duplicates and no gaps.

### 6.3 Performance

- `bun:test` bench: 1 000 sequential `append()` calls complete in ≤1 s
- `readFrom()` of 1 000-line log completes in <50 ms

### 6.4 Security Checks

- `sessionId` path component validated with `/^[a-zA-Z0-9_-]{1,128}$/` before any `Bun.file` call
- Log payload fields pass through SPEC-601 `sanitiseForLog()` before write
- No `eventId` integer overflow check needed (bigint is arbitrary precision)

## 7. Interfaces

```ts
// sessionLog.ts
export interface SessionEvent {
  eventId: string       // decimal bigint string, monotonic
  sessionId: string
  ts: number            // Unix ms
  topic: string         // e.g. 'session.user_message', 'session.tool_result'
  payload: unknown
}

export interface EventLog {
  append(sessionId: string, topic: string, payload: unknown): Promise<SessionEvent>
  readFrom(sessionId: string, fromEventId?: string, limit?: number): Promise<SessionEvent[]>
}

export function createEventLog(baseDir?: string): EventLog

// fanout.ts
export interface Fanout {
  subscribe(
    sessionId: string,
    fromEventId: string | undefined,
    onEvent: (e: SessionEvent) => void
  ): () => void           // returns unsubscribe fn
  publish(e: SessionEvent): void
}

export function createFanout(log: EventLog): Fanout

// cursor.ts
export function parseCursor(raw: string): bigint
export function cursorGt(a: string, b: string): boolean
export function cursorNext(current: string): string
```

## 8. Files Touched

- `src/channels/gateway/fanout.ts` (new, ~150 LoC — subscribe + publish + EventBus bridge)
- `src/channels/gateway/sessionLog.ts` (new, ~90 LoC — JSONL append + readFrom)
- `src/channels/gateway/cursor.ts` (new, ~40 LoC — bigint cursor helpers)
- `src/channels/http/wsStream.ts` (modify, +100 LoC — replay on upgrade, last-event-id header)
- `tests/channels/gateway/fanout.test.ts` (new, ~70 LoC)
- `tests/channels/gateway/sessionLog.test.ts` (new, ~30 LoC)

## 9. Open Questions

- None critical for v0.3.1.

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 OpenClaw sync port
