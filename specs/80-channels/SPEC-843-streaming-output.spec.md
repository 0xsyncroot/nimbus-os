---
id: SPEC-843
title: Streaming output render with spinner and markdown cache
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840]
blocks: [SPEC-845]
estimated_loc: 400
files_touched:
  - src/channels/cli/ink/components/AssistantMessage.tsx
  - src/channels/cli/ink/components/ToolUseMessage.tsx
  - src/channels/cli/ink/components/ToolResultMessage.tsx
  - src/channels/cli/ink/components/SpinnerWithVerb.tsx
  - src/channels/cli/ink/components/Markdown.tsx
  - src/channels/cli/ink/constants/figures.ts
  - src/channels/cli/ink/constants/spinnerVerbs.ts
  - tests/channels/cli/ink/streaming.test.ts
---

# Streaming Output Render with Spinner and Markdown Cache

## 1. Outcomes

- Assistant text renders with cached markdown (LRU 500-entry); repeat renders of same content achieve ≥90% cache hit rate.
- Spinner uses Claude Code–matching frames per OS, with stall detection interpolating to ERROR_RED `rgb(171,43,63)` and verb rotation from `spinnerVerbs.ts`.
- Tool-use blocks display `⏺` (macOS) / `●` (Linux + Windows) glyph from `figures.ts` plus tool name and formatted args.
- Reduced-motion fallback renders solid `●` dim with 2s brightness pulse; `NO_COLOR` strips all ANSI.

## 2. Scope

### 2.1 In-scope
- `AssistantMessage`: streaming text committed to `<Static>` on completion; markdown via `Markdown.tsx`.
- `Markdown.tsx`: `marked` streaming mode; LRU 500-entry hash-keyed cache; fast-path skip if no MD syntax in first 500 chars (`MD_SYNTAX_RE`).
- `ToolUseMessage`: glyph (`⏺`/`●`) + tool name + args summary.
- `ToolResultMessage`: per-tool renderer registry (extensible; SPEC-844 registers diff renderer).
- `SpinnerWithVerb`: `@inkjs/ui Spinner` + Claude Code ping-pong frames + verb rotation + stall color + reduced-motion fallback.
- `figures.ts`: OS-gated glyph constants. `spinnerVerbs.ts`: initial 20 gerund verbs.

### 2.2 Out-of-scope
- Structured diff rendering for Write/Edit results → SPEC-844.
- Collapsed Read/Search coalescing → SPEC-845.
- Per-tool permission dialogs → SPEC-846.
- Mouse selection + transcript rewind → deferred to v0.5.

## 3. Constraints

### Technical
- Bun ≥1.3.5, TypeScript strict, no `any`, max 400 LoC per file.
- Spinner frames match Claude Code per OS: `['·','✢','✳','✶','✻','✽']` ping-pong on macOS; ASCII fallback on non-UTF8 terminals.
- Stall color: linear RGB lerp from theme `claude` → `rgb(171,43,63)` over 0–5s.
- `NO_COLOR` disables ANSI; reduced-motion disables animation.
- `Markdown.tsx` tolerates partial streamed blocks — never crash on fragment.
- `marked` pinned exact (streaming API unstable across minors).

### Performance
- Markdown LRU cache hit ≥90% on 10-turn session replay.
- Fast-path skip when `MD_SYNTAX_RE` has no match in first 500 chars (reduces marked overhead for prose-only responses).
- Spinner frame update must not trigger full React tree re-render; use `useReducer` + `memo` to isolate.

### Resource / Business
- 1 dev part-time. ~400 LoC net.

## 4. Prior Decisions

- **Custom streaming markdown, not `ink-markdown`** — `ink-markdown` unmaintained ~2yr; doesn't tolerate partial blocks. Wrap `marked` streaming mode (~300 LoC). (META-011 §4)
- **`@inkjs/ui Spinner` base** — avoids re-implementing frame timing; extended with verb rotation + stall color. Claude Code: `Spinner.tsx:62`, `Spinner/utils.ts:4`, `SpinnerGlyph.tsx:7-68`.
- **`<Static>` for completed blocks** — prevents re-render on completed content; critical for long conversations.
- **Per-tool renderer registry** — extensible pattern from `AssistantToolUseMessage.tsx:35`; SPEC-844 registers diff renderer there.
- **LRU 500-entry, hash-keyed** — matches Claude Code markdown cache; hash collision negligible at this size.
- **Claude Code refs**: `AssistantTextMessage.tsx`, `Markdown.tsx:78`, `constants/figures.ts:4`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `figures.ts` | `TOOL_USE_GLYPH` = `⏺` on process.platform==='darwin', `●` otherwise; unit test for both | 40 | — |
| T2 | `spinnerVerbs.ts` | 20 gerund verbs exported as `SPINNER_VERBS: readonly string[]` | 20 | — |
| T3 | `Markdown.tsx` | LRU cache, fast-path skip, tolerates partial blocks, renders via `marked` | 100 | — |
| T4 | `SpinnerWithVerb.tsx` | Frames match Claude Code per OS; stall interpolation from t=0 to t=5; reduced-motion = dim pulse | 80 | T1, T2 |
| T5 | `AssistantMessage.tsx` | Streaming deltas update buffer; completed block committed to `<Static>`; markdown via T3 | 80 | T3 |
| T6 | `ToolUseMessage.tsx` | Glyph + tool name + args; uses `figures.ts`; `SpinnerWithVerb` during pending state | 60 | T1, T4 |
| T7 | `ToolResultMessage.tsx` | Registry pattern; default renderer for unknown tools; extensible slot for SPEC-844 | 50 | T5 |
| T8 | Tests | Cache hit ratio ≥90%; stall color at t=0,1,2,3,5s; frame arrays per OS; partial markdown no crash | 200 | T1-T7 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/streaming.test.ts`: cache hit ≥90% on 10 repeats; fast-path skip via spy; partial fenced code no throw; stall RGB at t=0,1,2,3,5 asserted.
- `describe('SPEC-843: streaming output', ...)` wrapper.

### 6.2 Gate B PTY Smoke
- 10-turn markdown session → cache hit ≥90% logged.
- Spinner frames correct on Linux (●) and macOS (⏺ ping-pong).
- `NO_COLOR=1` → no ANSI codes in output.

### 6.3 Performance Budgets
- Markdown cache hit ≥90% on 10-turn replay (META-011 §3.2).
- Spinner tick isolated to `SpinnerWithVerb` subtree — no full tree re-render.

### 6.4 Security Checks
- No raw prompt content logged to pino; assistant text passed to renderer only.

## 7. Interfaces

```ts
// figures.ts
export const TOOL_USE_GLYPH: string; // ⏺ on darwin, ● elsewhere
export const BULLET_GLYPH: string;   // ● always (status bullets)

// SpinnerWithVerb props
export interface SpinnerWithVerbProps {
  verb?: string;         // overrides random verb from SPINNER_VERBS
  stalled?: boolean;     // triggers color interpolation toward ERROR_RED
  stallSecs?: number;    // seconds since last delta (drives interpolation)
}

// AssistantMessage props
export interface AssistantMessageProps {
  blocks: AssistantTextBlock[];  // streaming deltas
  isComplete: boolean;
}

// ToolResultRenderer registry
export type ToolResultRenderer = (result: ToolResultBlock) => React.ReactElement;
export function registerToolResultRenderer(toolName: string, renderer: ToolResultRenderer): void;
```

## 8. Files Touched

- `src/channels/cli/ink/components/AssistantMessage.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/ToolUseMessage.tsx` (new, ~60 LoC)
- `src/channels/cli/ink/components/ToolResultMessage.tsx` (new, ~50 LoC)
- `src/channels/cli/ink/components/SpinnerWithVerb.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/Markdown.tsx` (new, ~100 LoC)
- `src/channels/cli/ink/constants/figures.ts` (new, ~40 LoC)
- `src/channels/cli/ink/constants/spinnerVerbs.ts` (new, ~20 LoC)
- `tests/channels/cli/ink/streaming.test.ts` (new, ~200 LoC)

## 9. Open Questions

- [ ] Verb set size: 20 for v0.4, port full ~500 from Claude Code in v0.4.1?
- [ ] Stall threshold: start interpolation at 2s or 3s? (Claude Code uses ~3s — match unless user prefers different)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-streaming.
