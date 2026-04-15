---
id: SPEC-108
title: Autonomy heuristics mini — auto plan-mode detector
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, SPEC-103, SPEC-105]
blocks: []
estimated_loc: 80
files_touched:
  - src/core/planDetector.ts
  - tests/core/planDetector.test.ts
---

# Autonomy Heuristics Mini

## 1. Outcomes

- Before provider call, `detectPlanMode(input, ctx)` returns `{plan: boolean, reason: string}` based on 3 hard-coded heuristics — runs in <1ms, pure function.
- When plan mode triggers, loop (SPEC-103) injects `[PLAN_MODE_REQUESTED]` cue into the system prompt (after `[AUTONOMY]`) so the LLM drafts a plan before acting — user hears the trigger reason via `LoopOutput{kind:'plan_announce'}`.
- Heuristic recall target: ≥80% of complex multi-step prompts flagged on 20-prompt fixture set covering diverse domains (research, scheduling, file mgmt, web automation, content writing, code, life mgmt); false-positive rate ≤10% on casual prompts.
- v0.1 hard-coded; v0.2 moves thresholds + cue vocabulary to `config.autonomy.planDetector` (SPEC-501).

## 2. Scope

### 2.1 In-scope
- 3 heuristics, any-match triggers:
  - **H1 Cue word**: prompt contains one of (case-insensitive, word boundary):
    - General: `plan|organize|prepare|coordinate|orchestrate|consolidate|reconcile|map out|set up|tổ chức|sắp xếp|chuẩn bị|lên kế hoạch`
    - Research/synthesis: `research|investigate|analyze|compare|summarize across|evaluate|nghiên cứu|phân tích|so sánh|tổng hợp`
    - Bulk ops: `migrate|reorganize|cleanup|restructure|batch|bulk|all|every|toàn bộ|tất cả|hàng loạt`
    - Code-specific: `refactor|rewrite|overhaul|rearchitect`
    - Communication: `compose campaign|draft series|reply to all|outreach|soạn loạt|gửi cho`
    - **Reasoning (bucket 4, `REASONING_CUE_WORDS`)**: EN `think deeply|deep think|think hard|think harder|ultrathink`; VN `suy nghĩ kỹ|nghĩ sâu|phân tích sâu|phân tích kỹ|tư duy sâu`. Match → `promoteToReasoning:true` (SPEC-106 `promoteClass`, one turn)
  - **H2 Predicted tool count**: ≥3 distinct tool-name mentions (e.g., "read mail then check calendar then draft reply" → Mail+Calendar+Edit; "list files then grep then archive" → Glob+Grep+Bash).
  - **H3 Scope estimate**: prompt mentions item-count ≥5 via regex (`/(\d+)\s*(file|loc|line|email|message|tab|item|task|event|record|tệp|email|thư|tab|mục|việc|sự kiện)/i`).
- Return `{plan, reason, matchedHeuristic, promoteToReasoning?}`; `promoteToReasoning` only on bucket-4 match.
- Static const vocabulary/regex exported for tests to pin.

### 2.2 Out-of-scope
- LLM-based plan detection → v0.3 (dedicated sub-agent).
- Config-driven heuristics → v0.2 (SPEC-501).
- Auto-execution of approved plan → v0.2 (plan approve/reject UX in CLI).
- Budget-based plan-mode trigger → v0.2 (requires cost estimator from v0.2).

## 3. Constraints

### Technical
- Pure sync function, zero I/O, zero randomness.
- TS strict, no `any`.
- Regex compiled once at module load (frozen).
- All throws `NimbusError(U_BAD_COMMAND, ctx)` — but detector should NEVER throw on normal input; throw only if input type is wrong (defensive).

### Performance
- `detectPlanMode()` <1ms per call (tiny regex set; 10K-char prompt bounded).

### Resource
- Zero allocations on common path (cue cache hit); small object on match.

## 4. Prior Decisions

- **Hard-coded heuristics for v0.1** — why not config-driven: v0.1 needs a stable baseline; config surface without usage data = premature abstraction.
- **3 heuristics, any-match** — why not weighted scoring: one-match OR keeps logic greppable and easy to tune; weighted models deferred until dataset exists.
- **Inject `[PLAN_MODE_REQUESTED]` via prompt builder, not a separate channel** — why: SPEC-105 already owns prompt assembly; adding a second path bypasses caching logic and splits responsibility.
- **Announce via `LoopOutput{kind:'plan_announce'}`** — why not stderr log: channels (CLI/WS) need to surface the trigger to user; reusing the existing LoopOutput union means no new event plumbing.
- **Heuristic names `H1/H2/H3` exposed in reason** — why: observability + test readability; `matchedHeuristic` drives per-rule false-positive tracking without scraping free-text.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Const vocabulary + regex compile | `CUE_WORDS`, `TOOL_NAMES`, `SCOPE_REGEX` frozen at module load | 20 | — |
| T2 | `detectPlanMode()` impl | runs 3 heuristics any-match; returns `{plan, reason, matchedHeuristic?}` | 30 | T1 |
| T3 | SPEC-103 loop hook | on `plan=true`, yield `{kind:'plan_announce', reason, heuristic}` + inject cue | 10 | T2 |
| T4 | SPEC-105 cue injection | append `[PLAN_MODE_REQUESTED]\n${reason}` after `[AUTONOMY]` when plan=true | 10 | T2 |
| T5 | 20-prompt fixture eval test | recall ≥80%, FP ≤10% on curated corpus | 10 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/planDetector.test.ts`:
  - `describe('SPEC-108: planDetector')`:
    - H1 general: `"organize my Downloads folder"` → `{plan: true, matchedHeuristic: 'H1'}`.
    - H1 research: `"research best laptop under 30 triệu, compare 5 options"` → `plan: true, matchedHeuristic: 'H1'`.
    - H1 communication: `"draft outreach series cho 10 contacts"` → `plan: true`.
    - H1 code: `"refactor auth flow"` → `plan: true`.
    - H1 case-insensitive: `"Plan"` matches; `"replan"` does not (word boundary).
    - H2: `"đọc mail từ Lan, check calendar tuần này, soạn reply"` → `plan: true, matchedHeuristic: 'H2'` (3 tool mentions).
    - H3: `"update 7 files in src/"` → `plan: true, matchedHeuristic: 'H3'`.
    - H3: `"reply to 12 emails"` → `plan: true`.
    - H3: `"backup 50 photos"` → `plan: true`.
    - Casual: `"mấy giờ rồi?"` → `plan: false`.
    - Casual: `"read the README"` (1 tool) → `plan: false`.
    - Casual: `"chào bạn"` → `plan: false`.
  - Fixture eval (`tests/fixtures/planDetector/corpus.json` with 20 prompts + expected labels):
    - Recall ≥80%.
    - False-positive rate ≤10%.

### 6.2 E2E Tests
- Covered via SPEC-103 loop test: mock prompt "plan event tuần này" → loop yields `plan_announce` before first provider call.

### 6.3 Performance Budgets
- `detectPlanMode()` <1ms on 10K-char prompt (bench 1000 iters).

### 6.4 Security Checks
- Regex has no catastrophic-backtracking patterns (no nested quantifiers); verified via ReDoS lint check.
- Untrusted content in prompt is DATA (per META-005 UNTRUSTED_CONTENT section) — detector runs on user input only, not tool output; documented in §4.

## 7. Interfaces

```ts
// planDetector.ts
export type Heuristic = 'H1' | 'H2' | 'H3'

export interface PlanDecision {
  plan: boolean
  reason: string                          // e.g., "cue word 'refactor' matched"
  matchedHeuristic?: Heuristic
  promoteToReasoning?: boolean            // bucket-4 match; orthogonal to plan
}

export function detectPlanMode(input: string): PlanDecision

// Exported constants (frozen) for tests + docs
// 3 buckets for per-domain false-positive tracking
export const CUE_WORDS_CODE = ['refactor','rewrite','migrate','restructure','rearchitect','overhaul'] as const
export const CUE_WORDS_RESEARCH = ['research','analyze','investigate','compare','survey','deep dive','deep-dive','nghiên cứu','phân tích','so sánh','tìm hiểu','tổng hợp'] as const
export const CUE_WORDS_PLANNING = ['plan','organize','schedule','coordinate','prepare','draft','consolidate','reconcile','set up','tổ chức','sắp xếp','chuẩn bị','lên kế hoạch'] as const
export const REASONING_CUE_WORDS = ['think deeply','deep think','think hard','think harder','ultrathink','suy nghĩ kỹ','nghĩ sâu','phân tích sâu','phân tích kỹ','tư duy sâu'] as const
export const CUE_WORDS = [...CUE_WORDS_CODE, ...CUE_WORDS_RESEARCH, ...CUE_WORDS_PLANNING] as const
export type Heuristic = 'H1-code' | 'H1-research' | 'H1-plan' | 'H2' | 'H3'
export const TOOL_NAMES: readonly string[]   // ['read','write','edit','grep','glob','bash']
export const SCOPE_REGEX: RegExp             // /(\d+)\s*(file|loc|line)/i
export const PLAN_CUE_BLOCK: string          // `[PLAN_MODE_REQUESTED]\nreason: {reason}`
```

## 8. Files Touched

- `src/core/planDetector.ts` (new, ~60 LoC)
- `tests/core/planDetector.test.ts` (new, ~100 LoC)
- `tests/fixtures/planDetector/corpus.json` (new fixture, 20 labeled prompts)

## 9. Open Questions

- [ ] Should H2 count tool-name occurrences or distinct tool-name set? v0.1: distinct set (3 unique tools). Distinct avoids gaming via "read read read".
- [ ] Cue word list may need Vietnamese variants (e.g., "tái cấu trúc", "di chuyển"). Defer to v0.2 i18n-aware detector.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
- 2026-04-15 @hiepht: add `REASONING_CUE_WORDS` (EN+VN) — `promoteToReasoning` via SPEC-106
