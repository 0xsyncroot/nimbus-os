---
id: SPEC-114
title: Self-reflection journal — periodic what-worked review
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.3
layer: core
depends_on: [META-005, SPEC-102, SPEC-104, SPEC-601, SPEC-701]
blocks: []
estimated_loc: 150
files_touched:
  - src/context/reflection.ts
  - src/skills/reflect/skill.md
  - tests/context/reflection.test.ts
---

# Self-Reflection Journal

## 1. Outcomes

- Every N turns (default 50) the agent writes a short reflection to `~/.nimbus/workspaces/{ws}/reflections/YYYY-MM-DD.md`
- Reflection answers three structured questions: "what worked", "what didn't", "next time try X" — forces signal, not vibes
- Bundled `/reflect` skill lets users trigger manually between auto-runs
- Reflections feed future Dreaming (v0.5) — each file self-contained markdown, easy to grep or feed as context

## 2. Scope

### 2.1 In-scope
- Per-session turn counter; trigger reflection on `turnCount % reflectionInterval === 0` (default 50)
- Reflection writer: single LLM call (workhorse class) with structured prompt returning 3 sections
- Atomic file write at `reflections/YYYY-MM-DD.md` (append if same day, new file otherwise)
- Bundled skill `/reflect [--session|--week]` allowing explicit trigger with scope flag
- Cost event with `isDream: true` (reflections are meta-work like Dreaming)
- Honor workspace config `reflection.enabled: boolean` (default `true`), `reflection.intervalTurns: number`

### 2.2 Out-of-scope
- Auto-apply reflection lessons to SOUL/TOOLS/rules → v0.4 (human-in-loop required)
- Cross-session synthesis (monthly digest) → v0.5 Dreaming
- LLM-as-judge scoring of reflection quality → v0.5

## 3. Constraints

### Technical
- File written with mode 0600 (personal content)
- Uses workspace LLM router → workhorse class; reasoning model NOT selected (overkill for structured self-assessment)
- Timeout 15s; on failure → log warn, no retry, no error propagation to session
- Must not include SOUL.md content in prompt (identity is input constraint, not reflection material)

### Performance / Cost
- Target <$0.01 per reflection (sonnet-tier, ~3K in + 500 out)
- Reflection latency budget 15s; runs async, user not blocked

## 4. Prior Decisions

- **Separate file per day, not monolithic log** — grep-friendly, easy to prune with housekeeper (365d retention, 20MB cap via `SPEC-601 registerRetention`)
- **Workhorse class not budget** — reflection requires self-analysis; Haiku output too shallow in pilot tests (reasoning about own behavior)
- **Three fixed questions, not free-form** — structured self-assessment reduces vagueness (soul.md wisdom: "if it can't predict your next take, it's too vague")
- **Bundled skill, not core command** — `/reflect` lives in `src/skills/reflect/` with `skill.md` manifest; future plugin ecosystem pattern (v0.5)

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Turn counter + trigger | `counter % 50 === 0` fires; config override; disabled → no fire | 20 | SPEC-102 |
| T2 | Reflection writer (LLM call + file) | Structured 3-section output; atomic write; mode 0600 | 60 | SPEC-104, SPEC-701 |
| T3 | Bundled `/reflect` skill | `skill.md` manifest + handler; `--session|--week` scope | 40 | T2 |
| T4 | Retention registration | Calls `SPEC-601 registerRetention({stream:'reflections', days:365, maxMb:20, perWorkspace:true})` | 10 | SPEC-601 |
| T5 | Config integration | `reflection.enabled`, `reflection.intervalTurns` via SPEC-501 | 20 | SPEC-501 |

## 6. Verification

### 6.1 Unit Tests
- Counter: 50 turns → 1 fire; 100 turns → 2 fires; disabled → 0
- Writer: output parses as 3 sections; absent section → re-prompt once, else fallback to raw dump with warn
- File: same-day second reflection appends under `## <HH:MM>` header; new day → new file
- `/reflect --session` triggers on demand regardless of counter
- Config: `reflection.enabled: false` suppresses both auto and skill handler (skill returns friendly message)

### 6.2 E2E Tests
- `tests/e2e/reflection.test.ts`: run 51-turn session → reflections file exists with today's date + 3 sections

### 6.3 Performance Budgets
- Reflection call <15s p95; cost <$0.01

### 6.4 Security Checks
- SENSITIVE_FIELDS scrubbed from session excerpt before prompt (shared redactor per SPEC-801)
- Reflections file mode 0600
- Agent CANNOT write SOUL.md from reflection path (separate pathValidator guard)

## 7. Interfaces

```ts
export const ReflectionSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  workspaceId: z.string(),
  sessionId: z.string(),
  scope: z.enum(['session','week']),
  worked: z.string(),                // "what worked"
  didntWork: z.string(),             // "what didn't"
  nextTry: z.string(),               // "next time try..."
  model: z.string(),
  costUsd: z.number(),
})
export type Reflection = z.infer<typeof ReflectionSchema>

export interface ReflectionJournal {
  onTurnIncrement(turnCount: number, sessionCtx: SessionContext): Promise<void>
  writeReflection(scope: 'session'|'week', sessionCtx: SessionContext): Promise<Reflection>
}
```

## 8. Files Touched

- `src/context/reflection.ts` (~100 LoC)
- `src/skills/reflect/skill.md` (manifest, not LoC)
- `src/skills/reflect/index.ts` (~30 LoC)
- `tests/context/reflection.test.ts` (~200 LoC)

## 9. Open Questions

- [ ] Should reflections be surfaced in next-session prompt? (lean no — MEMORY.md is the accepted mechanism, reflections stay as durable artifact)
- [ ] Weekly digest rollup (7d → 1 summary) — defer to v0.5 Dreaming

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
