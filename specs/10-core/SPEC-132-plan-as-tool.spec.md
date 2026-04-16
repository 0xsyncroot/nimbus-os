---
id: SPEC-132
title: Plan-as-Tool — TodoWriteTool for active plan management
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: core
depends_on: [META-001, META-004, SPEC-103, SPEC-108, SPEC-301, SPEC-401]
blocks: []
estimated_loc: 360
files_touched:
  - src/tools/todoWriteTool.ts
  - src/tools/todoWritePrompt.ts
  - src/core/todoStore.ts
  - src/core/loop.ts
  - src/channels/render/todoList.ts
  - tests/tools/todoWriteTool.test.ts
  - tests/core/todoStore.test.ts
---

# Plan-as-Tool — TodoWriteTool for active plan management

## 1. Outcomes

- Model actively plans via tool_use (not out-of-band LLM generation)
- User sees live-updating checklist as model progresses through task
- No pre-call LLM for spec generation → ~$0.001/turn saved
- Plan state session-inspectable (`nimbus session todos` or `/todos` slash)
- Supersedes SPEC-110's passive `[INTERNAL_PLAN]` injection

## 2. Scope

### 2.1 In-scope

- `TodoWriteTool` in tool registry with Zod input `{ todos: TodoItem[] }` — full list replacement (no diff API)
- `TodoItem`: `{id, content, activeForm, status, priority?, createdAt, updatedAt}`
- Status enum: `pending | in_progress | completed | cancelled`
- `todoStore.ts`: append-only JSONL at `sessions/{id}/todos.jsonl` + in-memory cache
- Diff computation server-side (added / status-changed / removed) → emits events
- Tool prompt baked with behavior rules (1 `in_progress` at time, mark BEFORE work, mark completed IMMEDIATELY after, never batch)
- Render to user: checklist with ANSI glyphs `[x]/[>]/[ ]/[-]` (completed/active/pending/cancelled)
- planDetector (SPEC-108) repurposed: emits NUDGE line ("consider TodoWrite") instead of triggering out-of-band spec
- SPEC-110 marked `status: superseded` (kept for history)

### 2.2 Out-of-scope (v0.4+)

- EnterPlanModeTool + ExitPlanModeTool (permission-mode toggle, different axis) — SPEC-133 v0.4
- Plan approval gate with user confirm
- Multi-agent shared todos
- Todo promotion to MEMORY.md (cross-session task tracking)
- Rich priority management UI

## 3. Constraints

### Technical
- Bun-native, TS strict, no `any`, max 400 LoC per file
- Full-list-replacement schema (matches Claude Code; avoids diff-merge bugs)
- Max 20 items per todo list (prompt budget + UI readability)
- Exactly one `in_progress` at a time (enforced at tool level)

### Performance
- Tool call <5ms (pure state mutation + append)
- Render ≤8 lines compact mode
- Persistence non-blocking (fire-and-forget JSONL append)

### Security
- Tool output wrapped in `<tool_output trusted="false">` for downstream model
- Todo content treated as user-authored text (no code exec)

## 4. Prior Decisions

- **Full-list replacement over `action: create|update` API** — matches Claude Code (src/tools/TodoWriteTool/TodoWriteTool.ts:31); model handles merge; no diff API complexity
- **Add `ulid` id (Claude Code lacks it)** — enables JSONL diff + cross-turn continuity; CC keys by array position which breaks on reorder
- **Remove out-of-band `taskSpec` generation** — violates vision "model drives planning". Saves Haiku pre-call cost + simplifies loop
- **High-risk detection moves to SPEC-401 permission gate** — plan risks was wrong abstraction; permission gate is the right centralizer
- **planDetector kept as NUDGE only** — cheap heuristic hint, not plan source. Model decides when to call TodoWrite based on prompt rules + nudge signal
- **Persist as JSONL snapshots** — one line per TodoWrite call = full replay history. Latest snapshot = source of truth
- **ANSI glyphs over emoji** — per nimbus convention, no emoji unless user explicit

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T0 | Flip SPEC-110 frontmatter: status → superseded, add `supersededBy: SPEC-132`. Atomic with SPEC-132 impl commit. | SPEC-110 frontmatter updated in same commit as first SPEC-132 code | 0 | — |
| T1 | Zod schemas + types (TodoItem, TodoSnapshot, TodoStatus) | schema round-trip test | 30 | — |
| T2 | `todoStore.ts` — append JSONL + read + latest + diff | 2 consecutive writes → 2 snapshots in file | 70 | T1 |
| T3 | `TodoWriteTool` impl with full-list replacement + enforce 1 in_progress | status-transition rules tested | 80 | T2 |
| T4 | Tool prompt (trimmed from Claude Code) with nimbus multi-domain examples | prompt < 2048 chars | 50 | — |
| T5 | `channels/render/todoList.ts` — checklist ANSI renderer | 4-state snapshot rendered correctly | 40 | T1 |
| T6 | `loop.ts` — remove taskSpec path + [INTERNAL_PLAN] block + emit `todos_updated` event | SPEC-110 paths deleted; event in audit | 40 | T3 |
| T7 | planDetector NUDGE — emit hint line instead of spec gen | nudge appears in system prompt on complex task | 10 | T6 |
| T8 | Tests — unit + integration + regression (no [INTERNAL_PLAN] in prompt) | all pass | 50 | all |

## 6. Verification

### 6.1 Unit Tests
- Schema round-trip; diff computation (add/status-change/remove); status-transition rules (only 1 `in_progress`); JSONL persistence round-trip
- Render: 4 states glyphs correct, strike-through on completed+cancelled

### 6.2 E2E Tests
- Multi-step request ("lên kế hoạch du lịch") triggers TodoWrite within 2 turns
- 3 sequential TodoWrite calls → 3 JSONL lines; latest snapshot is source of truth
- Regression: `[INTERNAL_PLAN]` absent from system prompt built in buildSystemPrompt

### 6.3 Performance
- Tool call <5ms (bench)
- 100 consecutive TodoWrite calls → JSONL append non-blocking (<50ms total I/O)

## 7. Interfaces

```ts
type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface TodoItem {
  id: string;              // ulid
  content: string;         // imperative: "Research destinations"
  activeForm: string;      // present continuous: "Researching destinations"
  status: TodoStatus;
  priority?: 'low' | 'medium' | 'high';
  createdAt: number;
  updatedAt: number;
}

interface TodoSnapshot {
  turnId: string;
  items: TodoItem[];
  ts: number;
}

// Tool schema
const TodoWriteInput = z.object({
  todos: z.array(TodoItemSchema).max(20),
});

// Store
interface TodoStore {
  append(sessionId: string, snapshot: TodoSnapshot): Promise<void>;
  readLatest(sessionId: string): Promise<TodoSnapshot | null>;
  readAll(sessionId: string): Promise<TodoSnapshot[]>;
}
```

## 8. Files Touched

- `src/tools/todoWriteTool.ts` (new, ~80 LoC)
- `src/tools/todoWritePrompt.ts` (new, ~50 LoC)
- `src/core/todoStore.ts` (new, ~70 LoC)
- `src/core/loop.ts` (modify — REMOVE taskSpec path; ~30 LoC delta)
- `src/channels/render/todoList.ts` (new, ~40 LoC)
- `tests/tools/todoWriteTool.test.ts` (new, ~80 LoC)
- `tests/core/todoStore.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Should `/todos` slash command show live list in REPL even when not being actively modified? (defer v0.3.1)
- [ ] Cross-session todo (e.g., "continue yesterday's plan")? (v0.4+)

## 10. Changelog

- 2026-04-16 @hiepht: draft — SPEC-110 is superseded. Plan-as-tool pattern ported from Claude Code (src/tools/TodoWriteTool/). Removes ~$0.001/turn Haiku pre-call cost. Net +180 LoC after SPEC-110 cleanup.
- 2026-04-16 @hiepht: v0.3 reviewer amendment — add T0 to atomically flip SPEC-110 to superseded+supersededBy:SPEC-132 in same commit as first SPEC-132 impl.
