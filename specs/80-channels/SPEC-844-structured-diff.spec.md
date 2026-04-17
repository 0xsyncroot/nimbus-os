---
id: SPEC-844
title: StructuredDiff colored unified diff for Write and Edit tools
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840]
blocks: []
estimated_loc: 200
files_touched:
  - src/channels/cli/ink/components/StructuredDiff.tsx
  - src/channels/cli/ink/components/StructuredDiffList.tsx
  - src/channels/cli/ink/components/StructuredDiff/colorDiff.ts
  - src/channels/cli/ink/components/StructuredDiff/Fallback.tsx
  - tests/channels/cli/ink/structured-diff.test.ts
---

# StructuredDiff Colored Unified Diff for Write and Edit Tools

## 1. Outcomes

- Write/Edit/MultiEdit tool results render as colored unified diffs with `+`/`-` gutter markers and right-aligned line numbers.
- Narrow-terminal fallback (columns − gutter < 20) collapses to single-column plain text with markers only.
- Per-hunk render is cached via `WeakMap` keyed on hunk object identity; repeat renders do not recompute.
- Pure-TS fallback renders correctly when native color-diff NAPI is absent (future-proof for Bun compiled binary).

## 2. Scope

### 2.1 In-scope
- `StructuredDiff.tsx`: single-hunk renderer with `+`/`-` color (green/red), gutter (2-pad + right-aligned line number), `WeakMap` cache.
- `StructuredDiffList.tsx`: wraps multiple hunks; handles hunk header (`@@ -N,M +N,M @@`) between hunks.
- `colorDiff.ts`: syntax colorizer using ANSI theme tokens; falls back to plain marker when `NO_COLOR` set.
- `Fallback.tsx`: plain-text single-column renderer for narrow terminal or absent NAPI.
- Registration in `ToolResultMessage` registry (SPEC-843 extensibility slot).

### 2.2 Out-of-scope
- Inline character-level diff highlighting (word diff) → deferred to v0.5.
- Mouse selection of diff text → deferred to v0.5.
- Side-by-side diff view → deferred (too wide for most terminals).
- Applying edits from the diff view (that is the tool's job, not the renderer).

## 3. Constraints

### Technical
- Bun ≥1.3.5, TypeScript strict, no `any`, max 400 LoC per file.
- `WeakMap` cache requires hunk objects to be stable references; callers must not re-create hunk objects on each render tick. Tool-event adapter must freeze and memoize hunk objects per `toolUseId`; re-emit the same references on re-render so `WeakMap` cache hits. If `JSON.parse` creates fresh objects each render, the cache never hits.
- Diff hunks are wrapped in `<Box borderStyle="dashed" borderColor="subtle" borderTop borderBottom>` (top and bottom borders only). Matches Claude Code `FileEditToolDiff.tsx:98`.
- Gutter width = 2 chars for marker (`+ `/`- `/`  `) + right-aligned line number; total gutter ≤8 chars.
- Narrow fallback threshold: `cols - GUTTER_WIDTH < 40` → use `Fallback.tsx`. (Was ambiguous between `cols < 40` and `cols - GUTTER < 20`; unified here. Cite Claude Code `StructuredDiff.tsx:56-60`.)
- `NO_COLOR` → strip all ANSI; use plain `+`/`-` chars only.
- NAPI absence detection: `colorDiff.ts` must `try/require` the NAPI module and gracefully fall through to pure-TS path.

### Performance
- `WeakMap` cache hit must bypass all diff computation on repeat render.
- Rendering a 200-line diff must complete in ≤50ms cold (measured in unit test).

### Resource / Business
- 1 dev part-time. ~200 LoC net.

## 4. Prior Decisions

- **`WeakMap` cache by hunk identity** — avoids string-keyed Map memory leak as hunk objects are GC'd naturally with conversation history. Claude Code ref: `components/StructuredDiff.tsx`.
- **Gutter spec from Claude Code** — `StructuredDiff.tsx:43-48` (2-pad + right-align). We match exactly for visual parity.
- **Narrow fallback** — `StructuredDiff.tsx:56-60` threshold pattern; prevents horizontal scroll artifacts in <40-col terminals.
- **Pure-TS NAPI fallback** — Bun compiled binary bundles WASM/NAPI but environment variability (Alpine, musl, Windows) warrants a graceful degrade path; `colorDiff.ts` dual-path approach.
- **Register in SPEC-843 registry** — `ToolResultMessage` has an extensibility registry; StructuredDiff registers itself for `write`/`edit`/`multiedit` tool names.
- **Claude Code refs**: `components/StructuredDiff.tsx`, `StructuredDiff/colorDiff.ts`, `StructuredDiff/Fallback.tsx`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `colorDiff.ts` | NAPI try-require; pure-TS fallback; `NO_COLOR` strips ANSI; exports `colorize(line, type)` | 40 | — |
| T2 | `Fallback.tsx` | Renders plain marker + text; no ANSI; ≤20-col budget per line | 20 | — |
| T3 | `StructuredDiff.tsx` | `+`/`-` colored gutter, right-aligned line number, `WeakMap` cache, narrow check | 80 | T1, T2 |
| T4 | `StructuredDiffList.tsx` | Wraps multiple hunks with hunk headers; registers in SPEC-843 tool result registry | 40 | T3 |
| T5 | Tests | 200-line diff ≤50ms; cache hit bypasses compute; narrow collapse at cols<40; `NO_COLOR` no ANSI; NAPI-absent fallback | 100 | T1-T4 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/structured-diff.test.ts`: colored +/- output; gutter line number right-aligned; `WeakMap` cache hit confirmed via spy; narrow terminal (mock cols=35) → `Fallback` renders; `NO_COLOR=1` → no ANSI codes; NAPI mock absent → fallback path.
- `describe('SPEC-844: StructuredDiff', ...)` wrapper.

### 6.2 PTY Smoke
- Gate B PTY: drive a Write tool on a 10-line file → diff renders in terminal with color (or plain on `NO_COLOR`).

### 6.3 Performance Budgets
- 200-line diff cold render ≤50ms (bun:test bench).
- Cached re-render ≤1ms (WeakMap lookup only).

### 6.4 Security Checks
- File paths in diff output are display-only; not re-executed or resolved.
- No raw file content logged to pino audit stream.

## 7. Interfaces

```ts
// Hunk type (shared with tool result blocks)
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

// StructuredDiff props
export interface StructuredDiffProps {
  hunk: DiffHunk;
  cols?: number; // defaults to process.stdout.columns
}

// StructuredDiffList props
export interface StructuredDiffListProps {
  filePath: string;
  hunks: DiffHunk[];
}

// colorDiff.ts
export function colorize(line: DiffLine, noColor: boolean): string;
```

## 8. Files Touched

- `src/channels/cli/ink/components/StructuredDiff.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/StructuredDiffList.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/StructuredDiff/colorDiff.ts` (new, ~40 LoC)
- `src/channels/cli/ink/components/StructuredDiff/Fallback.tsx` (new, ~20 LoC)
- `tests/channels/cli/ink/structured-diff.test.ts` (new, ~100 LoC)

## 9. Open Questions

- [ ] Word-level diff (character-level `+`/`-` highlighting within a changed line) — defer to v0.5 or include now? (recommendation: defer, adds ~80 LoC + complexity)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-streaming.
- 2026-04-17 @hiepht: detail-pass — added dashed Box border (top+bottom, FileEditToolDiff.tsx:98 ref); hunk-object freeze+memoize per toolUseId for WeakMap correctness; unified narrow-fallback threshold to cols-GUTTER_WIDTH<40 (StructuredDiff.tsx:56-60 ref)
