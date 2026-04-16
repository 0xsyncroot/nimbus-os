---
id: SPEC-110
title: Runtime SDD — agent generates task spec before executing
status: superseded
supersededBy: SPEC-132
version: 0.2.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-16
release: v0.1
layer: core
depends_on: [META-001, META-005, SPEC-103, SPEC-108, SPEC-401]
blocks: []
estimated_loc: 200
files_touched:
  - src/core/taskSpec.ts
  - src/core/taskSpecPrompt.ts
  - tests/core/taskSpec.test.ts
---

# Runtime SDD — Agent Writes Mini-Spec Before Executing

## 1. Outcomes

- User describes intent in plain language across **any domain** (research, scheduling, email, web, file mgmt, code, life mgmt). Agent self-controls.
- Agent generates a 5-section mini-spec **internally** (~80-150 words) for non-trivial tasks. Structured thinking improves plan quality vs reactive free-form — this is the differentiator.
- Agent shows the spec inline as a **FYI announcement** ("Đây là kế hoạch…") in 1-2 short paragraphs, then **executes immediately**. User can `/stop` or comment to redirect.
- **High-risk actions** (`spec.risks.severity === 'high'`: mass email, payment, bulk delete) trigger a single inline confirm. Permission gate (SPEC-401) handles destructive ops orthogonally — that is the user safety net, not runtime SDD.
- Executed specs persist to `task-specs/<turnId>.spec.md` (background write) for audit/replay.
- Skip spec for trivial tasks (heuristic from SPEC-108).

## 2. Scope

### 2.1 In-scope (v0.1)
- Task spec generator: 1 Haiku call → 5-section mini-spec
- **Inline FYI display** (5-8 lines) — announcement, not a gate
- **High-risk auto-flag**: generator scores `risks.severity`; `high` → single confirm
- **Opt-in `/spec-confirm always`** slash cmd (default OFF)
- Background persist to `~/.nimbus/workspaces/{ws}/sessions/{id}/task-specs/<turn>.spec.md`
- Integration with SPEC-108 + SPEC-103

### 2.2 Out-of-scope
- ~~Per-turn approval prompt~~ **REMOVED** — autonomous by default
- Multi-turn spec refinement, templates (v0.2)
- Visual diff UI (v0.4)

## 3. Constraints

### Technical
- Spec generation ≤2s p95 (Haiku, ~500/200 tokens)
- Persistence **non-blocking** (fire-and-forget, error logged)
- Generator failure → fall back to direct execution

### UX
- FYI display fits **5-8 terminal lines**
- Zero blocking I/O for standard-risk specs
- High-risk confirm: single keypress y/n, default n

### Resource
- Cost per spec ~$0.001.

## 4. Prior Decisions

- **Autonomous-first execution** — vision "agent tự chủ thật sự". An AI OS used dozens of times/day dies if every turn needs user `y/n`. Autonomy is the product.
- **Spec is internal planning aid, not a user gate** — side effects = FYI display + audit trail. The agent plans better thinking in spec format; that reliability gain is the value.
- **Permission gate (SPEC-401) is the safety net** — orthogonal. Mode=default still confirms `rm`, email-send, force-push. SDD does NOT replace permissions.
- **High-risk flag → single confirm** — narrow safeguard for `risks.severity='high'` (mass ops, payments, system writes), not blanket approval.
- **Opt-in `/spec-confirm always`** — power users who want per-turn review can enable. Default OFF.
- **Fallback to direct execution on generator failure** — graceful degradation; worst case = reactive agent.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | `TaskSpecSchema` Zod (5 sections + `risks.severity`) | validate roundtrip + invalid rejected | 30 | — |
| T2 | `generateTaskSpec(userMsg, env)` LLM call | <2s p95, parsed TaskSpec w/ risk score | 55 | T1 |
| T3 | `displaySpecInline(spec)` FYI render | ≤8 lines, synchronous, ANSI | 30 | T2 |
| T5 | `highRiskGate(spec)` | if severity='high' → single inline confirm | 25 | T2, T3 |
| T6 | `/spec-confirm <on|off|always>` slash cmd | toggle opt-in per-turn confirm mode | 15 | T5 |
| T7 | `persistSpecAsync(spec)` background write | atomic write, non-blocking, error log | 20 | T2 |
| T8 | Integrate into `agentLoop` (SPEC-103) | runs after SPEC-108 plan-detect, before tools | 25 | T2-T7 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/taskSpec.test.ts`:
  - Generator returns valid 5-section spec with `risks.severity` ∈ {low, medium, high}
  - `displaySpecInline` caps at 8 lines, ANSI-clean
  - `highRiskGate`: severity='high' → confirm invoked; 'medium'/'low' → skipped
  - `/spec-confirm always` toggle: persists flag to session config
  - Persistence: async write, errors logged not thrown

### 6.2 E2E Tests
- `tests/e2e/runtime-sdd.test.ts`:
  - "mấy giờ rồi?" → no spec (trivial)
  - "tóm tắt 5 mail mới nhất" → spec generated, FYI shown, **executes immediately** (no approval prompt)
  - "xoá 50 file trong ~/Downloads" → spec marks `severity='high'` → single confirm prompt → execute on y
  - Generator API failure → fall back to direct execution + log warning
  - `/spec-confirm always` on → every spec triggers confirm regardless of severity

### 6.3 Performance Budgets
- Spec generation: <2s p95
- FYI display render: <50ms
- Persistence: non-blocking (main thread unblocked in <5ms)

## 7. Interfaces

```ts
const RiskAssessmentSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()).default([]),
})

const TaskSpecSchema = z.object({
  schemaVersion: z.literal(2),
  turnId: z.string(),
  generatedAt: z.number(),
  outcomes: z.string().min(10).max(300),
  scope: z.object({ in: z.array(z.string()).min(1), out: z.array(z.string()).default([]) }),
  actions: z.array(z.object({ tool: z.string(), reason: z.string().min(5) })),
  risks: RiskAssessmentSchema,
  verification: z.string().min(5),
})
export type TaskSpec = z.infer<typeof TaskSpecSchema>
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>

export interface TaskSpecGenerator {
  generate(userMessage: string, env: EnvironmentSnapshot): Promise<TaskSpec>
  shouldGenerate(userMessage: string, verdict: PlanVerdict): boolean
}

export declare function displaySpecInline(spec: TaskSpec): void // FYI, synchronous
export declare function confirmHighRisk(spec: TaskSpec): Promise<boolean> // only when risks.severity='high'
export declare function persistSpecAsync(spec: TaskSpec): void // background, non-blocking
```

## 8. Files Touched

- `src/core/taskSpec.ts` (new, ~130 LoC)
- `src/core/taskSpecPrompt.ts` (new, ~50 LoC) — generator system prompt incl. risk scoring rubric
- `tests/core/taskSpec.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] FYI display format: short prose vs compact table?
- [ ] High-risk threshold: LLM self-judge vs heuristic rules (keywords + tool allowlist)?

## 10. Changelog

- 2026-04-15 @hiepht: initial draft. Runtime SDD as differentiator — "spec-before-plan makes agentic more effective".
- 2026-04-15 @hiepht: **refactor per user clarification** — autonomous-first execution, no per-turn approval. Spec is internal planning aid; permission gate (SPEC-401) is user safety net. High-risk auto-flag triggers single confirm. Opt-in `/spec-confirm always` for power users.
- 2026-04-16 superseded by SPEC-132 (plan-as-tool, TodoWriteTool). Out-of-band Haiku spec generation removed from loop; plan state now owned by model via tool_use. `taskSpec` parameter dropped from `buildSystemPrompt`; `[INTERNAL_PLAN]` block absent from all prompt outputs.
