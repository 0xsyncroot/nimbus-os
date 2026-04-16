---
id: SPEC-112
title: Dreaming Lite — end-of-session MEMORY.md consolidation
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-16
release: v0.2
layer: core
depends_on: [META-005, SPEC-102, SPEC-104, SPEC-304, SPEC-701]
blocks: []
estimated_loc: 120
files_touched:
  - src/context/memoryConsolidation.ts
  - tests/context/memoryConsolidation.test.ts
---

# Dreaming Lite — End-of-Session Memory Consolidation

## 1. Outcomes

- When a session ends (REPL `/quit`, SIGTERM, or daemon graceful shutdown), nimbus makes ONE short LLM call summarizing the session and appends a bullet to workspace `MEMORY.md` under `# Observations`
- Completes in <3s p95 using a fast/budget model class (Haiku-tier)
- Skips consolidation when session cost is already high, turn count is too low, or duration too short — prevents cost regression and noise
- User-visible: on next session, MEMORY.md contains recent `# Observations` entries, persisted across sessions without manual effort (OpenClaw read-on-wake pattern)

## 2. Scope

### 2.1 In-scope
- Hook into session-end lifecycle (`onSessionClose` emitted by SPEC-102 store)
- Trigger rules: `turnCount ≥ 10` AND `duration ≥ 15min` AND `session.totalCostUsd < $0.50`; also triggered when user explicitly runs `/reflect --session`
- Build consolidation prompt from session excerpt (last N turns, de-duplicated tool outputs); capped input ≤16K tokens
- Single LLM call via current workspace model router (override to `budget` class)
- Append one `- <fact> (<YYYY-MM-DD>)` bullet to `MEMORY.md` `# Observations` section (created if absent) using `SPEC-304 MemoryTool` append path — NEVER edits `# Durable Facts` or anywhere else
- Record a `CostEvent` with `isDream: true` for cost attribution (SPEC-701)

### 2.2 Out-of-scope
- Light/Deep/REM multi-phase Dreaming → v0.5 (this is Lite only, single-phase)
- `DREAMS.md` narrative writing → v0.5 (scaffolded by SPEC-901 update)
- Cross-session theme extraction → v0.3 SPEC-114 reflection journal
- SOUL.md edits → never (META-005 agent-never-writes-SOUL rule)

## 3. Constraints

### Technical
- Uses `SPEC-304 MemoryTool.append()` — must acquire `fcntl` lock (see META-005 §2.3 write rules)
- Runs after final turn metric flushed (SPEC-601 `flush()`); runs BEFORE store close
- Timeout 10s hard; on timeout → skip with `T_TIMEOUT` logged warn, NOT error (consolidation is best-effort)
- No network writes other than the one LLM call; no multi-hop

### Performance / Cost
- Target cost per consolidation <$0.002 (Haiku ~1K in, 100 out)
- Overhead on session close <3s p95; async hook so does NOT block user exit beyond 3s (fire-and-forget when possible; REPL exits while write finishes in background, 3s join on SIGTERM)

## 4. Prior Decisions

- **Move from v0.5 to v0.2** — low LoC (~120), high value (memory persistence from day-one user), Haiku-tier cost is negligible; Deep Dreaming multi-phase stays v0.5
- **Append-only, no compaction or rewrite** — identical safety stance as SPEC-304; preserves user curation intent
- **Budget model class, not workhorse** — consolidation is summarization, not reasoning; Haiku/gpt-4o-mini suffice; saves ~5-10× vs sonnet
- **Skip when session cost >$0.50** — users already paid; piling on another call is perverse when the session was expensive anyway (likely already context-rich)
- **Fire-and-forget with 3s join** — never delay user's `/quit` perceptually

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | `onSessionClose` hook + trigger rules | Skipped for cost >$0.50, turns <10, dur <15min (3 fixtures) | 30 | SPEC-102 |
| T2 | Consolidation prompt builder | Truncates to ≤16K tokens; excludes raw secrets (uses SENSITIVE_FIELDS scrub from SPEC-801) | 35 | SPEC-104 |
| T3 | LLM call + MEMORY.md append | Single bullet added under `# Observations`; fcntl lock; atomic | 40 | SPEC-304 |
| T4 | Cost attribution + logging | `CostEvent.isDream=true` emitted; fail → log warn, don't throw | 15 | SPEC-701 |

## 6. Verification

### 6.1 Unit Tests
- Trigger: below each threshold → no call made (3 cases)
- Trigger: above thresholds → call made exactly once
- Prompt: raw API key in session scrubbed before LLM call
- Append: MEMORY.md existing `# Durable Facts` untouched; new bullet goes under `# Observations`
- Append: absent `# Observations` section → section header auto-created
- Lock: concurrent append blocked (fcntl exclusive)

### 6.2 E2E Tests
- `tests/e2e/dreaming-lite.test.ts`: run 12-turn session → `/quit` → subprocess exits <3s → MEMORY.md file has +1 bullet dated today

### 6.3 Performance Budgets
- Close-to-exit latency p95 <3s
- Cost per consolidation <$0.002 (Haiku, 2026 prices)

### 6.4 Security Checks
- Never includes SOUL.md content in consolidation prompt (identity not data)
- Scrubs SENSITIVE_FIELDS from session excerpt before LLM call
- Emits SecurityEvent if consolidation output contains regex-matching secret shapes (rare guard against LLM echo)

## 7. Interfaces

```ts
export const ConsolidationResultSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  skipped: z.boolean(),
  skipReason: z.enum(['low_turns','short_duration','cost_cap','disabled','timeout','error']).optional(),
  observation: z.string().optional(),    // the single bullet content written
  costUsd: z.number().default(0),
})
export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>

export interface MemoryConsolidator {
  onSessionClose(sessionId: string): Promise<ConsolidationResult>
  isEligible(sessionStats: { turns: number; durationMs: number; costUsd: number }): boolean
}
```

## 8. Files Touched

- `src/context/memoryConsolidation.ts` (~100 LoC)
- `tests/context/memoryConsolidation.test.ts` (~180 LoC)

## 9. Open Questions

- [ ] Make trigger thresholds config-driven via SPEC-501? (lean yes, v0.2 shipping defaults)
- [ ] Allow opt-out via `/no-consolidate` slash in last turn? (v0.3 extension)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial (moved from v0.5 to v0.2 per plan revision)
- 2026-04-16 @hiepht: implemented v0.2 Lite — heuristic-only extraction (no LLM call); `src/context/memoryConsolidation.ts` + 26 unit tests green
