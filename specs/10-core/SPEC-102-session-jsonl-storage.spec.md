---
id: SPEC-102
title: Session + JSONL storage with schemaVersion
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-004, SPEC-101, SPEC-201]
blocks: [SPEC-103, SPEC-801]
estimated_loc: 220
files_touched:
  - src/core/session.ts
  - src/core/sessionManager.ts
  - src/storage/sessionStore.ts
  - src/core/sessionTypes.ts
  - tests/core/session.test.ts
  - tests/storage/sessionStore.test.ts
---

# Session + JSONL Storage

## 1. Outcomes

- Every turn appends to `sessions/{id}/messages.jsonl` and `events.jsonl` before returning — crash after LLM response but before write cannot happen (write is the ACK).
- `loadSession(id)` rehydrates `CanonicalMessage[]` in <200ms for 10K messages; malformed lines quarantined to `.broken.{ts}.jsonl` without aborting load (S_STORAGE_CORRUPT self-heal).
- `listSessions(wsId)` returns sessions sorted by `lastMessage` desc with meta preview (turnCount, tokenCount) without reading `messages.jsonl`.
- Every JSONL file starts with a schema header line `{"schemaVersion":1,"type":"header"}` — downstream migration tooling keys off this.

## 2. Scope

### 2.1 In-scope
- `SessionMeta` schema (`id`, `wsId`, `createdAt`, `lastMessage`, `turnCount`, `tokenCount`, `schemaVersion`).
- Append-only JSONL store: `messages.jsonl` (CanonicalMessage per line) + `events.jsonl` (monotonic-ID event log for future mobile cursor sync).
- `meta.json` updates via `fsync` after each turn (cheap, small file).
- Corrupt line recovery: invalid JSON line → skip + write to `.broken.{ts}.jsonl` next to original, update `meta.json.recoveredLines`.
- `sessionManager.ts`: in-memory active session cache per workspace + subscription broadcast.

### 2.2 Out-of-scope
- Session compact / summary → v0.2 (SPEC-105 in v0.2 scope, not v0.1).
- Multi-channel shared session → v0.4.
- SQLite index → v0.5 (keep JSONL primary).
- Event bus routing to channels → SPEC-801.

## 3. Constraints

### Technical
- Bun `Bun.file().writer()` append for JSONL (buffered, flushes on `.flush()`).
- Line size limit: 256KB per JSON line (reject write with `T_VALIDATION`; signal error to loop).
- `fsync` frequency: after each turn boundary (not per tool call) — balance durability vs overhead.
- `CanonicalMessage` Zod validation on every read (untrusted boundary after corrupt-line fix).
- Monotonic `eventId`: `sessionStartEpochMs × 10^5 + sequenceInSession` (collision-free within session).

### Performance
- `appendMessage()` <5ms (buffered write, not synced unless turn boundary).
- `loadSession(10K msgs)` <200ms.
- `listSessions(100)` <50ms (meta-only, no JSONL scan).

### Resource
- `messages.jsonl` rolls at 100MB → auto-rename to `messages.{ts}.jsonl` + start fresh (v0.1 simple rotation).
- Memory: in-memory cache for active session only; LRU evict on inactive after 10min idle.

## 4. Prior Decisions

- **JSONL, not SQLite** — why: append-only crash-safe; grep-friendly debug; zero schema migration for the primary log. Ref META-001 §3.
- **Separate `events.jsonl`** — why not one file: events are monotonic + channel-sync-targeted (future mobile resumes from `eventId > cursor`); messages are LLM-domain. Mixing complicates schema and bloats each consumer.
- **meta.json next to JSONL** — why: list view must not scan message bodies; meta is derivable but cache is worth it.
- **schemaVersion header as first JSONL line** — why: migration tooling reads head without parsing body; survives file truncation/corruption at tail.
- **Quarantine corrupt lines, not abort** — why: single broken line (disk page corruption) shouldn't lose 10K good messages. Trade-off: silent partial load → mitigated by `recoveredLines` count surfaced in REPL banner.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `SessionMetaSchema` + `MessageLineSchema` Zod | rejects missing `schemaVersion` header; validates each line | 30 | — |
| T2 | `sessionStore.create()` | creates dir, writes `meta.json`, schema header lines in both JSONLs | 40 | T1 |
| T3 | `appendMessage()` + `appendEvent()` | buffered write; monotonic eventId; flush on turn boundary | 60 | T2 |
| T4 | `loadSession()` | parses line-by-line, quarantines bad lines, returns `CanonicalMessage[]` | 60 | T2 |
| T5 | `listSessions()` meta-only | reads `meta.json` of each; sorted by lastMessage desc | 20 | T2 |
| T6 | `sessionManager` cache + LRU | 10min idle evict; subscribe API for future channel broadcast | 50 | T3, T4 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/session.test.ts`:
  - `describe('SPEC-102: session storage')`:
    - Create + append 100 messages + load → equals input.
    - Append message with 300KB body → throws `NimbusError(T_VALIDATION, {reason:'line_size_exceeded', size})` (write-side validation; `S_STORAGE_CORRUPT` reserved for load-time detection).
    - Inject broken middle line (write garbage) + load → loads 99, quarantines 1, `meta.recoveredLines=1`.
    - Header missing → throws `S_SCHEMA_MISMATCH`.
    - `schemaVersion: 2` in header → throws `S_SCHEMA_MISMATCH`.
  - `describe('SPEC-102: sessionManager')`:
    - Cache hit <0.1ms; cache miss triggers load.
    - 10min idle → evicted from cache.

### 6.2 E2E Tests
- `tests/e2e/session.test.ts`: REPL `/new` + message + kill process + restart + `/sessions` lists previous session with correct turnCount.

### 6.3 Performance Budgets
- `loadSession(10K msgs)` <200ms.
- `appendMessage()` <5ms median.
- `listSessions(100)` <50ms.

### 6.4 Security Checks
- Line size >256KB rejected (prevents JSONL parser DoS).
- Path validation: `wsId` / `sessionId` from untrusted input routed through SPEC-101 paths only.
- `events.jsonl` is tamper-evident only in v0.2 (audit chain); v0.1 detects file-shrink between reads and emits `SecurityEvent{eventType:'events_file_shrunk', severity:'warn', sessionId, prevSize, currSize, blocked:false}` to SPEC-601 observability bus (does not abort load).

## 7. Interfaces

```ts
// sessionTypes.ts
export const SessionMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),        // ULID
  wsId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  createdAt: z.number().int().positive(),
  lastMessage: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  recoveredLines: z.number().int().nonnegative().default(0),
})
export type SessionMeta = z.infer<typeof SessionMetaSchema>

export const MessageLineSchema = z.object({
  schemaVersion: z.literal(1),
  turnId: z.string(),
  message: z.unknown(),                                      // CanonicalMessage from SPEC-201
  ts: z.number().int().positive(),
})

export type SessionEvent =
  | { eventId: number; ts: number; type: 'user_msg'; text: string }
  | { eventId: number; ts: number; type: 'assistant_start'; turnId: string }
  | { eventId: number; ts: number; type: 'assistant_end'; turnId: string; tokens: number }
  | { eventId: number; ts: number; type: 'tool_start'; toolUseId: string; name: string }
  | { eventId: number; ts: number; type: 'tool_end'; toolUseId: string; ok: boolean }

// sessionStore.ts
export interface SessionStore {
  create(wsId: string): Promise<SessionMeta>
  appendMessage(sessionId: string, msg: CanonicalMessage, turnId: string): Promise<void>
  appendEvent(sessionId: string, ev: Omit<SessionEvent, 'eventId'>): Promise<number>
  loadSession(sessionId: string): Promise<CanonicalMessage[]>
  listSessions(wsId: string): Promise<SessionMeta[]>
  flush(sessionId: string): Promise<void>                    // fsync on turn boundary
}

// sessionManager.ts
export function getActiveSession(wsId: string): SessionMeta | null
export function setActiveSession(wsId: string, sessionId: string): Promise<void>
export function subscribeEvents(sessionId: string, cb: (ev: SessionEvent) => void): Disposable
```

## 8. Files Touched

- `src/core/session.ts` (new, ~40 LoC)
- `src/core/sessionManager.ts` (new, ~50 LoC)
- `src/core/sessionTypes.ts` (new, ~40 LoC)
- `src/storage/sessionStore.ts` (new, ~140 LoC)
- `tests/core/session.test.ts` (new, ~120 LoC)
- `tests/storage/sessionStore.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] JSONL rotation threshold — keep 100MB or 50MB? Default 100MB; revisit post-usage data.
- [ ] Event cursor sync primitive for mobile (v0.3+) — design here or in SPEC-protocol? Defer.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
