---
id: SPEC-845
title: Collapsed Read/Search coalescing and background task progress
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-843]
blocks: []
estimated_loc: 150
files_touched:
  - src/channels/cli/ink/components/CollapsedReadSearch.tsx
  - src/channels/cli/ink/components/ToolUseLoader.tsx
  - src/channels/cli/ink/utils/collapseReadSearch.ts
  - tests/channels/cli/ink/collapse.test.ts
---

# Collapsed Read/Search Coalescing and Background Task Progress

## 1. Outcomes

- Back-to-back `Read` + `Grep` + `Glob` tool events within a single agent turn coalesce into one summary line (e.g., "Read 3 files, searched for 'foo' → 12 matches").
- Mixed sequences containing non-read tools (e.g., Read → Bash → Read) do NOT coalesce across the non-read boundary.
- Long-running tools (`Bash`) show a progress indicator with elapsed time in `mm:ss` format.
- `ToolUseLoader` renders a spinner for any slow tool with no result yet (pending state).

## 2. Scope

### 2.1 In-scope
- Pure coalesce algorithm in `collapseReadSearch.ts`: takes `ToolEvent[]`, returns `CoalescedGroup[]`; groups consecutive Read/Grep/Glob runs; emits group summary string.
- `CollapsedReadSearch.tsx`: renders a single coalesced summary line with file count + search terms + match count.
- `ToolUseLoader.tsx`: spinner + elapsed `mm:ss` counter for pending tool; clears on result receipt.
- Integration: `ToolResultMessage` (SPEC-843 registry) renders collapsed groups via `CollapsedReadSearch`.

### 2.2 Out-of-scope
- Collapsing Bash tool output → Bash shown individually with `ToolUseLoader` progress only.
- Per-tool custom collapsing beyond Read/Grep/Glob → extensible registry deferred to v0.5.
- Historical turn collapsing (collapse across turns) → not needed, coalescing is per-turn only.

## 3. Constraints

### Technical
- Bun ≥1.3.5, TypeScript strict, no `any`, max 400 LoC per file.
- `collapseReadSearch.ts` is a pure function (no React, no side effects) — unit-testable without Ink.
- Coalesce boundary: any tool event whose `toolName` is NOT in `COLLAPSIBLE_TOOLS` (`Read`, `Grep`, `Glob`) breaks the current group.
- `ToolUseLoader` elapsed counter uses `Date.now()` on mount; updates via `setInterval(1000)` — must clear interval on unmount.
- Summary string format: `"Read {N} file{s}, searched {terms} → {M} match{es}"` — localization deferred.

### Performance
- Coalesce algorithm O(n) in number of tool events — no nested loops.
- `ToolUseLoader` interval must be cleared on unmount to prevent memory leak.

### Resource / Business
- 1 dev part-time. ~150 LoC net.

## 4. Prior Decisions

- **Pure coalesce function, not component state** — separating the algorithm into `collapseReadSearch.ts` enables unit testing without a rendering harness and matches Claude Code's `utils/collapseReadSearch.ts` pattern.
- **Coalesce only consecutive same-category tools** — mixing Bash between Reads produces two separate Read groups; this matches user expectation (Bash is visible work, Reads flanking it are separate contexts).
- **`ToolUseLoader` as standalone** — Claude Code's `components/ToolUseLoader.tsx` is a thin wrapper we replicate; keeps spinner logic isolated from coalescing logic.
- **SPEC-843 registry integration** — `CollapsedReadSearch` registers for `read`/`grep`/`glob` tool names; no special-casing in `ToolResultMessage` body.
- **Claude Code refs**: `components/messages/CollapsedReadSearchContent.tsx`, `utils/collapseReadSearch.ts`, `components/ToolUseLoader.tsx`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `collapseReadSearch.ts` | Pure function; 3x Read + 1x Grep → 1 group; Read → Bash → Read → 2 groups; empty input → empty output | 40 | — |
| T2 | `CollapsedReadSearch.tsx` | Renders summary string; file count, search terms, match count from group data | 60 | T1 |
| T3 | `ToolUseLoader.tsx` | Spinner + `mm:ss` elapsed; interval cleared on unmount; accepts `toolName` prop for label | 30 | — |
| T4 | Registry integration | `CollapsedReadSearch` registered for `read`/`grep`/`glob` in SPEC-843 `ToolResultMessage` registry | 0 | T2, T3 |
| T5 | Tests | Coalesce algorithm unit tests; CollapsedReadSearch render; ToolUseLoader elapsed display + cleanup | 80 | T1-T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/collapse.test.ts`:
  - `collapseReadSearch`: 3x Read + 1x Grep → 1 group summary; mixed sequence → correct split; empty → `[]`.
  - `CollapsedReadSearch`: renders "Read 3 files, searched for 'foo' → 12 matches".
  - `ToolUseLoader`: elapsed `mm:ss` increments correctly; `clearInterval` called on unmount (spy).
- `describe('SPEC-845: collapsed read/search', ...)` wrapper.

### 6.2 PTY Smoke
- Gate B PTY: drive a sequence of `Read` + `Grep` calls → single coalesced line visible in terminal.
- `ToolUseLoader` shows elapsed seconds during a mocked slow Bash tool.

### 6.3 Performance Budgets
- Coalesce of 100-event sequence completes ≤1ms (O(n) algorithm).
- No memory leak from un-cleared intervals (confirmed via unmount test).

### 6.4 Security Checks
- Search terms shown in summary are display-only; not re-evaluated as shell expressions.
- File paths in coalesced summary are display labels only.

## 7. Interfaces

```ts
// collapseReadSearch.ts
export const COLLAPSIBLE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
export type CollapsibleToolName = typeof COLLAPSIBLE_TOOLS[number];

export interface ToolEvent {
  toolName: string;
  args: Record<string, unknown>;
  result?: { matchCount?: number; lineCount?: number };
}

export interface CoalescedGroup {
  type: 'read-search';
  fileCount: number;
  searchTerms: string[];
  matchCount: number;
  events: ToolEvent[];
}

export function collapseReadSearch(events: ToolEvent[]): Array<CoalescedGroup | ToolEvent>;

// CollapsedReadSearch props
export interface CollapsedReadSearchProps {
  group: CoalescedGroup;
}

// ToolUseLoader props
export interface ToolUseLoaderProps {
  toolName: string;
  startedAt: number; // Date.now() at tool start
}
```

## 8. Files Touched

- `src/channels/cli/ink/components/CollapsedReadSearch.tsx` (new, ~60 LoC)
- `src/channels/cli/ink/components/ToolUseLoader.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/utils/collapseReadSearch.ts` (new, ~40 LoC)
- `tests/channels/cli/ink/collapse.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should Glob be shown with its own line count in summary, or merged with Read file count? (current: merged)
- [ ] Threshold for "slow tool" that shows `ToolUseLoader`: 500ms or 1s? (default 500ms, aligns with user perception)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-streaming.
