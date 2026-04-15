---
id: SPEC-601
title: Observability foundation — metrics + errors + logger + store
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: observability
depends_on: [META-003, SPEC-151]
blocks: [SPEC-701, SPEC-103, SPEC-401]
estimated_loc: 300
files_touched:
  - src/observability/schema.ts
  - src/observability/errors.ts
  - src/observability/logger.ts
  - src/observability/store.ts
  - src/observability/housekeeper.ts
  - tests/observability/*.test.ts
---

# Observability Foundation

## 1. Outcomes

- Every turn/tool/security event emits typed metric into JSONL store in <2ms (hot path overhead)
- `NimbusError` + `classify()` + `ErrorCode` enum available system-wide; 100% of throw sites use `NimbusError`
- `logger` (pino) provides `info|warn|error|debug` with automatic context binding (turnId, sessionId)
- Monthly-sharded JSONL at `~/.nimbus/logs/metrics/YYYY-MM-DD.jsonl` + rotation + gzip >7d + hard cap 500MB

## 2. Scope

### 2.1 In-scope
- **schema.ts**: Zod `TurnMetric`, `ToolMetric`, `SecurityEvent`, `SystemHealth` — ALL fields concrete per plan §11 (see §7)
- **errors.ts**: `ErrorCode` enum (P*/T*/S*/X*/U*/Y* from META-003), `NimbusError` class, `classify(err)`, `isRetryable()`, `isUserFacing()` — behavior table in §7
- **logger.ts**: pino base logger + child loggers (`logger.child({turnId})`), file sink + stdout when TTY
- **store.ts**: three independent streams — `metrics/` (turn+tool+health), `security/` (hash-chained, separate budget), `traces/` (v0.5). Append-only JSONL, per-day file handle cache, fsync batched every 100ms
- **housekeeper.ts**: daily cron with **per-stream retention**: metrics 30d + 500MB cap, traces 7d + 100MB cap, security **90d default + 200MB cap with tamper-break alert BEFORE eviction** (see §3 Storage). Gzip >7d. Consumers (e.g., SPEC-701 cost 12mo) register custom retention via `registerRetention({stream, days, maxMb})`

### 2.2 Out-of-scope
- Self-heal policy dispatch → v0.2 `selfHeal/policies.ts`
- Dashboard CLI (`nimbus status|health|metrics`) → v0.3
- OTEL exporter → v0.5 (schema reserves `spanId`/`traceId` fields)
- Prometheus `/metrics` endpoint → v0.3
- Sampling adaptive → v0.2 (v0.1 = 100% turns/errors, 10% tool body)

## 3. Constraints

### Technical
- Pino >=9, configured sync-only for v0.1 (simpler; async worker v0.2)
- JSONL one event per line, `\n` delimited, UTF-8, schemaVersion=1 header line per file
- No `console.log` anywhere in codebase — lint-enforced
- Errors crossing module boundaries MUST be `NimbusError`

### Performance
- `record(metric)` p99 <0.5ms (Zod parse + write to in-memory buffer)
- Flush batch of 100 metrics <5ms
- Overhead per turn <2ms, per tool <0.5ms

### Storage
- **Per-stream budgets (resolves T15 vs 500MB-cap conflict)**:
  - `~/.nimbus/logs/metrics/YYYY-MM-DD.jsonl` — 30d retention, 500MB cap, oldest-first eviction
  - `~/.nimbus/logs/traces/YYYY-MM-DD.jsonl` — 7d retention, 100MB cap (v0.5 actual use)
  - `~/.nimbus/logs/security/YYYY-MM.jsonl` — 90d default retention, 200MB cap, **hash-chained append-only**. Housekeeper NEVER silently evicts; on cap breach it writes `X_AUDIT_BREAK` security event + refuses new writes until user acknowledges (escalate-user). Cost ledger (SPEC-701) sits on its own budget (12mo, per-workspace) via `registerRetention()`
- Consumer-registered retention: SPEC-701 calls `registerRetention({stream:'cost', days:365, maxMb:50})`; housekeeper honors

## 4. Prior Decisions

- **JSONL not SQLite** — append-only crash-safe; grep-friendly; consistent with sessions (SPEC-102)
- **ErrorCode stable strings not integers** — see META-003 §3
- **pino over winston** — 5× faster, smaller, better child logger ergonomics
- **schema owned here, emitters elsewhere** — permissions/tools/loop import types; 601 owns validation + store
- **v0.1 100% sampling** — cheap when local, deterministic; adaptive tiers deferred v0.2
- **Security stream separate from metrics** — T15 (META-009) requires tamper-proof audit. Security events on their own budget + hash chain prevent silent eviction when a high-traffic metrics burst fills the 500MB cap. Trade-off: two handles instead of one; negligible cost, essential isolation.
- **TurnMetric.costUsd vs SPEC-701 CostEvent** — complementary not duplicate: `CostEvent` is per-LLM-request (richer, used for ledger/forecast), `TurnMetric.costUsd` is aggregated per turn for fast dashboard rollup. Turn aggregator sums CostEvents of that turn. Documented here to prevent drift.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Zod schemas (Turn/Tool/Security/Health) | All fields required per plan §11; fixture roundtrip | 70 | — |
| T2 | `ErrorCode` enum + `NimbusError` + `classify()` | All 6 families; classify test 100% branch cov | 60 | — |
| T3 | pino logger + child binding | `logger.child({turnId})` propagates; writes to sink + stdout | 40 | — |
| T4 | JSONL store writer | Append, batched fsync, file handle rotation at day boundary | 60 | T1 |
| T5 | Housekeeper cron + `registerRetention()` | Per-stream budgets honored; security cap emits `X_AUDIT_BREAK` not silent evict | 60 | T4 |
| T6 | Hot-path helpers: `recordTurn`, `recordTool`, `recordSecurity`, `recordHealth` | Inline emit + error swallow (never throw from obs); SHA-256 digest for security payloads | 30 | T2, T4 |
| T7 | Hash-chained security writer | Each event includes `prevHash`; chain verifies on read; break → `X_AUDIT_BREAK` | 40 | T4 |

## 6. Verification

### 6.1 Unit Tests
- `schema.test.ts`: each schema validates full+minimal fixtures; malformed rejected
- `errors.test.ts`: `classify(new TypeError())` → `T_CRASH`; fetch AbortError → `T_TIMEOUT`; ECONNREFUSED → `P_NETWORK`; 429 → `P_429`
- `logger.test.ts`: child logger inherits bindings; `logger.error(err)` includes code + context
- `store.test.ts`: 10K appends roundtrip; crash mid-write leaves last-line-truncated file, reader skips bad tail
- `housekeeper.test.ts`: file >7d gzipped; >30d deleted; 500MB cap evicts oldest

### 6.2 E2E Tests
- `tests/e2e/obs-turn.test.ts`: run a turn → JSONL file contains exactly 1 `TurnMetric` + N `ToolMetric` with matching turnId

### 6.3 Performance Budgets
- `bench/obs.bench.ts`: `recordTurn()` avg <0.5ms; 1K tool metrics flushed <50ms

### 6.4 Security Checks
- Security events record `payloadDigest` (SHA-256), NEVER raw bash command or prompt
- Log sanitizer strips `api_key|token|password|authorization` from context payloads (regex)
- Store files mode 0600

## 7. Interfaces

```ts
// --- schema.ts ---
export const TurnMetricSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  channel: z.enum(['cli','http','ws','telegram','slack']),
  provider: z.string(),
  model: z.string(),
  tokens: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  cacheHitRatio: z.number().min(0).max(1),      // cacheRead / (input + cacheRead)
  costUsd: z.number(),                           // aggregate of per-turn CostEvents (SPEC-701); rollup, not source of truth
  toolCalls: z.number(),
  toolErrors: z.number(),
  retries: z.number(),
  outcome: z.enum(['ok','error','cancelled']),
  errorCode: z.string().optional(),              // ErrorCode value if outcome=error
  firstTokenLatencyMs: z.number().optional(),
  mode: z.string(),                              // permission mode active during turn
  spanId: z.string().optional(),                 // reserved for OTEL v0.5
  traceId: z.string().optional(),                // reserved for OTEL v0.5
})
export type TurnMetric = z.infer<typeof TurnMetricSchema>

export const ToolMetricSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  turnId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),                        // internal id
  toolUseId: z.string(),                         // wire-format id (Anthropic tool_use_id / OpenAI tool_call_id)
  name: z.string(),                              // 'Bash' | 'Read' | ...
  durationMs: z.number(),
  outcome: z.enum(['ok','error','cancelled','denied']),
  errorCode: z.string().optional(),
  inSizeBytes: z.number(),                       // JSON-stringified input byte length
  outSizeBytes: z.number(),                      // output byte length
  concurrencyBatch: z.number().default(1),       // parallel tool batch size this belonged to
  retries: z.number().default(0),
})
export type ToolMetric = z.infer<typeof ToolMetricSchema>

export const SecurityEventSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  eventId: z.string(),                           // ULID
  eventType: z.enum(['bash_blocked','path_blocked','injection_detected','cred_access','audit_break','network_blocked','bypass_activated']),
  severity: z.enum(['info','warn','high','critical']),
  payloadDigest: z.string().length(64),          // SHA-256 hex over sensitive payload; NEVER raw content
  reason: z.string(),                            // human-readable short summary, must not contain raw secrets
  blocked: z.boolean(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  toolName: z.string().optional(),
  prevHash: z.string().length(64),               // SHA-256 of previous line (hash chain for T15)
})
export type SecurityEvent = z.infer<typeof SecurityEventSchema>

export const SystemHealthSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  rssBytes: z.number(),
  heapUsedBytes: z.number(),
  heapTotalBytes: z.number(),
  eventLoopLagMs: z.number(),
  activeSessions: z.number(),
  mcpStatus: z.record(z.string(), z.enum(['up','down','degraded'])),  // serverId → status
  providerLatencyP95Ms: z.record(z.string(), z.number()),             // providerId → p95
  diskPctUsed: z.number().min(0).max(100),
  diskFreeBytes: z.number(),
})
export type SystemHealth = z.infer<typeof SystemHealthSchema>

// --- errors.ts ---
export enum ErrorCode {
  // Provider
  P_NETWORK='P_NETWORK', P_5XX='P_5XX', P_429='P_429', P_AUTH='P_AUTH',
  P_INVALID_REQUEST='P_INVALID_REQUEST', P_CONTEXT_OVERFLOW='P_CONTEXT_OVERFLOW', P_MODEL_NOT_FOUND='P_MODEL_NOT_FOUND',
  // Tool
  T_TIMEOUT='T_TIMEOUT', T_CRASH='T_CRASH', T_VALIDATION='T_VALIDATION',
  T_PERMISSION='T_PERMISSION', T_NOT_FOUND='T_NOT_FOUND', T_MCP_UNAVAILABLE='T_MCP_UNAVAILABLE',
  T_ITERATION_CAP='T_ITERATION_CAP',
  // Session/Storage
  S_COMPACT_FAIL='S_COMPACT_FAIL', S_STORAGE_CORRUPT='S_STORAGE_CORRUPT', S_CONFIG_INVALID='S_CONFIG_INVALID',
  S_SOUL_PARSE='S_SOUL_PARSE', S_MEMORY_CONFLICT='S_MEMORY_CONFLICT', S_SCHEMA_MISMATCH='S_SCHEMA_MISMATCH',
  // Security
  X_BASH_BLOCKED='X_BASH_BLOCKED', X_PATH_BLOCKED='X_PATH_BLOCKED', X_NETWORK_BLOCKED='X_NETWORK_BLOCKED',
  X_INJECTION='X_INJECTION', X_CRED_ACCESS='X_CRED_ACCESS', X_AUDIT_BREAK='X_AUDIT_BREAK',
  // User
  U_BAD_COMMAND='U_BAD_COMMAND', U_MISSING_CONFIG='U_MISSING_CONFIG',
  // System
  Y_OOM='Y_OOM', Y_DISK_FULL='Y_DISK_FULL', Y_SUBAGENT_CRASH='Y_SUBAGENT_CRASH', Y_DAEMON_CRASH='Y_DAEMON_CRASH',
  Y_CIRCUIT_BREAKER_OPEN='Y_CIRCUIT_BREAKER_OPEN',
}

export class NimbusError extends Error {
  constructor(public readonly code: ErrorCode, public readonly ctx: Record<string, unknown> = {}, public override readonly cause?: Error) {
    super(`${code}: ${JSON.stringify(ctx)}`); this.name = 'NimbusError'
  }
  get retryable(): boolean { return isRetryable(this.code) }
  get userFacing(): boolean { return isUserFacing(this.code) }
}

export function classify(err: unknown): ErrorCode
export function isRetryable(code: ErrorCode): boolean
export function isUserFacing(code: ErrorCode): boolean

// --- isRetryable/isUserFacing behavior (derived from family prefix, with overrides) ---
// | Family | isRetryable | isUserFacing | Exceptions |
// |--------|-------------|--------------|------------|
// | P_*    | true        | false        | P_AUTH + P_INVALID_REQUEST → retryable=false, userFacing=true |
// | T_*    | partial     | false        | T_PERMISSION + T_VALIDATION + T_NOT_FOUND + T_ITERATION_CAP → retryable=false, userFacing=true; T_TIMEOUT + T_CRASH + T_MCP_UNAVAILABLE → retryable=true |
// | S_*    | false       | true         | all storage errors surface to user |
// | X_*    | false       | true         | security NEVER retryable, ALWAYS userFacing (META-009) |
// | U_*    | false       | true         | user errors by definition userFacing |
// | Y_*    | true        | true         | system errors retryable via supervisor restart; userFacing for transparency; Y_CIRCUIT_BREAKER_OPEN → retryable=false until operator resets |

// --- store.ts ---
export interface MetricStore {
  recordTurn(m: TurnMetric): void
  recordTool(m: ToolMetric): void
  recordSecurity(e: SecurityEvent): void
  recordHealth(h: SystemHealth): void
  flush(): Promise<void>
  close(): Promise<void>
}
```

## 8. Files Touched

- `src/observability/schema.ts` (~90 LoC)
- `src/observability/errors.ts` (~100 LoC)
- `src/observability/logger.ts` (~50 LoC)
- `src/observability/store.ts` (~100 LoC)
- `src/observability/housekeeper.ts` (~60 LoC)
- `tests/observability/` (~300 LoC)

## 9. Open Questions

- [ ] Async worker for pino (v0.2 perf) — defer unless p99 regresses
- [ ] Structured redaction config (per-field) — v0.2

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — concrete ToolMetric + SystemHealth schemas; add `cacheHitRatio` to TurnMetric; separate security stream with hash chain + own budget (resolves T15 vs cap conflict); `registerRetention()` API for per-stream budgets (cost 12mo); isRetryable/isUserFacing behavior table; document TurnMetric.costUsd ↔ SPEC-701 CostEvent relationship
- 2026-04-15 @hiepht: sync ErrorCode enum with META-003 — add `T_ITERATION_CAP` (tool family) and `Y_CIRCUIT_BREAKER_OPEN` (system family); update isRetryable/isUserFacing table accordingly
