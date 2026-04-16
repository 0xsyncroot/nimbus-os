---
id: SPEC-603
title: Observability dashboard CLI — status/health/metrics/errors/trace/audit/cost
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: observability
depends_on: [SPEC-601, SPEC-602, SPEC-701, SPEC-119]
blocks: []
estimated_loc: 200
files_touched:
  - src/cli/commands/status.ts
  - src/cli/commands/health.ts
  - src/cli/commands/metrics.ts
  - src/cli/commands/errors.ts
  - src/cli/commands/trace.ts
  - src/cli/commands/audit.ts
  - src/observability/rollup.ts
  - src/observability/reader.ts
  - tests/cli/commands/dashboard.test.ts
---

# Observability dashboard CLI

## 1. Outcomes

- Users and power users diagnose nimbus state via `nimbus status`, `nimbus health`, `nimbus metrics`, `nimbus errors`, `nimbus trace`, `nimbus audit`, `nimbus cost`
- All commands <500ms for 30-day JSONL shard (HDR rollup cache)
- Read-only (never mutate logs); `--json` for scripting

## 2. Scope

### 2.1 In-scope

8 CLI commands:

| Command | Output | Filters |
|---------|--------|---------|
| `nimbus status` | 1-line: OK \| last err \| today cost | — |
| `nimbus health` | subsystems + memory + disk | `--json` |
| `nimbus metrics` | p50/p95/p99 + tokens + cost per provider/model | `--since 1h\|1d`, `--json` |
| `nimbus errors` | count by ErrorCode + last occurrence + circuit state | `--since`, `--code X_*` |
| `nimbus trace <turnId>` | tree: turn → tool_calls → retries → errors | `--json` |
| `nimbus audit` | SecurityEvent + exec/write tool calls | `--since`, `--severity` |
| `nimbus cost` | today/week/month + forecast + export | `--today`, `--by`, `--forecast`, `--export csv\|json` |

Infrastructure:
- Streaming JSONL reader (line-by-line, no full-file load)
- HDR histogram rollup cached 5min (hdr-histogram-js)
- Day-sharded pruning by `--since`

### 2.2 Out-of-scope

- `nimbus diagnose` (LLM-powered root cause) — v0.3.1 via DiagnoseSkill
- Web dashboard (v0.4)
- Grafana Prometheus scrape endpoint (v0.5)

## 3. Constraints

### Performance
- Each command <500ms @ 30-day shard
- Rollup cache 5min TTL

### Security
- Read-only — NEVER mutate logs
- Audit log never truncated (preserves forensics)
- `--json` sanitizes output (no ANSI codes)

## 4. Prior Decisions

- **Streaming line-reader over SQLite** — JSONL is append-only + greppable + crash-safe; SQLite overkill for single-user
- **HDR histogram rollup** — p50/p95/p99 accurate to 3 decimals with bounded memory
- **Day-sharded files** — `~/.nimbus/logs/metrics/YYYY-MM-DD.jsonl` → easy `--since` pruning
- **Cached rollup 5min** — balance freshness vs rollup cost
- **`--json` mode for scripting** — exit code reflects health (status=0 OK, 1 degraded, 2 down)

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | `reader.ts` — streaming JSONL + `--since` filter | reads 30d shard <300ms | 40 | — |
| T2 | `rollup.ts` — HDR histogram + 5min cache | p99 accuracy test | 30 | T1 |
| T3 | `status` + `health` commands | subsystem probe <100ms parallel | 30 | T1,T2 |
| T4 | `metrics` + `errors` + `cost` commands | <500ms bench | 50 | T2 |
| T5 | `trace` command — turn tree join on turnId | TurnMetric + ToolMetric join correct | 30 | T1 |
| T6 | `audit` command — security + exec/write filter | severity filter works | 20 | T1 |

## 6. Verification

### 6.1 Unit Tests
- Reader: stream parse, malformed line skip, `--since` filter
- Rollup: p50/p95/p99 accuracy, cache TTL
- Each command: output shape, `--json` mode

### 6.2 Performance Budgets
- 30-day 100K-event shard: status <100ms, metrics <500ms, trace <200ms (via bench)

### 6.3 Security Checks
- Audit log: never truncated by any command
- `--json` output has no ANSI codes
- `nimbus audit` shows X_* events even without elevated permissions

## 7. Interfaces

```ts
interface ReaderOpts { since?: string; until?: string; filter?: (line: unknown) => boolean }
function streamJsonl(path: string, opts: ReaderOpts): AsyncIterable<unknown>;

interface RollupCache {
  get(metric: string, provider: string, model: string): HistogramSnapshot | null;
  refresh(sinceMs: number): Promise<void>;
}

type HealthLevel = 'ok' | 'degraded' | 'down';
interface HealthReport {
  overall: HealthLevel;
  subsystems: Record<string, { status: HealthLevel; detail?: string }>;
  memoryMb: number;
  diskFreeMb: number;
  eventLoopLagMs: number;
}
```

## 8. Files Touched

- `src/observability/reader.ts` (new, ~40 LoC)
- `src/observability/rollup.ts` (new, ~30 LoC)
- `src/cli/commands/{status,health,metrics,errors,trace,audit}.ts` (new, ~100 LoC total)
- `src/cli/commands/cost.ts` (extend existing, ~30 LoC)
- `tests/cli/commands/dashboard.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Should `nimbus cost --forecast` use P50/P90 from historical burn or 7-day trend? (P50/P90 v0.3)

## 10. Changelog

- 2026-04-16 @hiepht: draft — Phase 1 self-heal+observability analyst report
