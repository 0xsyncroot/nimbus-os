---
id: SPEC-848
title: StatusLine, PromptInputFooter, and TaskListV2 components
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840]
blocks: []
estimated_loc: 300
files_touched:
  - src/channels/cli/ink/components/StatusLine.tsx
  - src/channels/cli/ink/components/PromptInputFooter.tsx
  - src/channels/cli/ink/components/TaskListV2.tsx
  - src/channels/cli/ink/hooks/useTasks.ts
  - tests/channels/cli/ink/status.test.ts
---

# StatusLine, PromptInputFooter, and TaskListV2 Components

## 1. Outcomes

- `<StatusLine>` renders the bottom row (workspace · model · mode · $today · ctx%) live; redraws on SIGWINCH without flicker.
- `<TaskListV2>` subscribes to the event bus `tools.todoUpdate` topic, clamps visible tasks to `min(10, max(3, rows-14))`, and fades completed tasks after 30s TTL.
- `<PromptInputFooter>` degrades gracefully at narrow/short breakpoints (`isNarrow` when `cols < 80`, `isShort` when `rows < 24`); mode badge and permission-mode symbol remain visible in all modes.
- Owner column in `TaskListV2` is hidden when `cols < 60` to preserve readability on tight terminals.

## 2. Scope

### 2.1 In-scope

- `StatusLine.tsx` — single bottom row: workspace name · model short-name · current mode badge · `$today` cost · context percentage. Updates on `AppContext` change + SIGWINCH.
- `PromptInputFooter.tsx` — row below prompt input: mode badge (`normal` / `vim` / `plan`), permission-mode symbol, notification count. `isNarrow` (cols < 80) and `isShort` (fullscreen + rows < 24) breakpoint props per SPEC-849 `useBreakpoints`.
- `TaskListV2.tsx` — subscribes to `tools.todoUpdate` event bus topic via `useTasks` hook; renders tasks with `figures` icons: `✔` done, `◼` in_progress, `◻` pending; `blocked-by` list prefixed with `▸`; activity ellipsis on in_progress; owner badge hidden when `cols < 60`.
- `useTasks.ts` — subscribes to the event bus, returns typed `Task[]`; 30s TTL for recently-completed tasks.
- Max-displayed formula: `min(10, max(3, rows - 14))` matching Claude Code `TaskListV2.tsx:48`.

### 2.2 Out-of-scope

- Task creation / editing → agent loop concern, not UI component.
- Vim-mode input handling → SPEC-841 PromptInput.
- Notification persistence → SPEC-610 observability events.

## 3. Constraints

### Technical

- Bun ≥1.3.5. TypeScript strict, no `any`. Max 400 LoC per file.
- Layer rule (SPEC-833): `channels/cli/` accesses task state only via event bus topic `tools.todoUpdate`; no direct import of AgentLoop internals.
- `figures` icons must degrade to ASCII (`[x]`, `[.]`, `[ ]`) when `noColor` is true and terminal doesn't support Unicode (detected via `process.env.TERM`).
- SIGWINCH triggers `AppContext` cols/rows update (SPEC-840); `StatusLine` consumes via `useContext(AppCtx)` — no direct `process.stdout` subscription.

### Performance

- `StatusLine` re-render ≤1ms (text concat only, no layout recalculation).
- `useTasks` TTL sweep runs on a 5s interval via `useEffect` + `clearInterval` on unmount; no memory leak.

### Resource / Business

- 1 dev part-time. Event bus already exists in nimbus-os core.

## 4. Prior Decisions

- **`min(10, max(3, rows-14))` clamp from Claude Code `TaskListV2.tsx:48`.** Magic numbers encode: 3 = minimum useful list; 10 = visual overload threshold; 14 = rows consumed by StatusLine + prompt + header. Copying the formula gives parity without guessing.
- **30s TTL for completed tasks from Claude Code `TaskListV2.tsx:21`.** Long enough to see what just finished; short enough to not pollute the list. Configurable only via spec revision, not user setting (v0.4).
- **`figures` package for icons.** Provides consistent Unicode/ASCII fallback table without per-platform branching. Same dependency as Claude Code.
- **Event bus subscription, not prop drilling.** `TaskListV2` mounts anywhere in the tree; polling via event bus decouples it from AgentLoop lifecycle. Matches SPEC-833 channel-layer isolation rule.
- **Claude Code references**: `components/StatusLine.tsx:138`, `components/TaskListV2.tsx:30-377` (icons line 224-240; max-display line 48; TTL line 21), `components/PromptInput/PromptInputFooter.tsx:105-110`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `useTasks.ts` hook | Subscribes to `tools.todoUpdate`; returns `Task[]`; TTL sweep removes completed after 30s | 30 | — |
| T2 | `TaskListV2.tsx` | Renders with correct icons; clamp formula applied; owner hidden at cols<60; blocked-by prefix | 100 | T1 |
| T3 | `StatusLine.tsx` | Renders workspace·model·mode·cost·ctx% in one row; updates on AppContext change | 80 | — |
| T4 | `PromptInputFooter.tsx` | Mode badge + permission symbol; `isNarrow`/`isShort` props collapse non-essential elements | 80 | — |
| T5 | `status.test.ts` | All clamp boundary values; TTL expiry; owner column toggle; SIGWINCH redraw; footer breakpoints | 120 | T1–T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/status.test.ts`:
  - `TaskListV2` clamp at `rows=17` → 3 tasks shown; `rows=24` → 10 tasks shown.
  - Completed task disappears from rendered output after TTL mock advance (30 000ms).
  - Owner column absent in `lastFrame()` when `cols=59`; present at `cols=60`.
  - `StatusLine` shows updated model name after `AppContext` change.
  - `PromptInputFooter` omits notification count label when `isNarrow=true`.
  - Vim-mode badge present when mode is `vim`.

### 6.2 Gate B PTY Smoke

- Resize 80→60 cols: owner column disappears from task list; `StatusLine` truncates model name (META-011 §6.2 step 5).
- Task marked done in agent loop → appears in TaskListV2 with `✔` → fades after 30s (verified in extended PTY session).

### 6.3 Performance Budget

- `StatusLine` render <1ms: `performance.now()` bench with 100 iterations.

## 7. Interfaces

```ts
// src/channels/cli/ink/hooks/useTasks.ts
export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  owner?: string;
  blockedBy?: string[];
  completedAt?: number; // epoch ms
}
export function useTasks(): Task[]

// src/channels/cli/ink/components/StatusLine.tsx
export function StatusLine(): React.ReactElement

// src/channels/cli/ink/components/PromptInputFooter.tsx
export interface PromptInputFooterProps {
  isNarrow: boolean;
  isShort: boolean;
  notificationCount: number;
}
export function PromptInputFooter(props: PromptInputFooterProps): React.ReactElement

// src/channels/cli/ink/components/TaskListV2.tsx
export function TaskListV2(): React.ReactElement
```

## 8. Files Touched

- `src/channels/cli/ink/components/StatusLine.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/PromptInputFooter.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/TaskListV2.tsx` (new, ~100 LoC)
- `src/channels/cli/ink/hooks/useTasks.ts` (new, ~30 LoC)
- `tests/channels/cli/ink/status.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Should `StatusLine` show MCP connection count alongside model name? (nice-to-have, defer to v0.4.1)
- [ ] `TaskListV2` scroll: should user be able to scroll past the clamp to see older tasks? (defer to v0.4.1)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-dialogs; synthesized from META-011 Phase E + Claude Code status/tasklist research
