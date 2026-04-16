---
id: SPEC-825
title: Confirm flow wiring — destructive tools prompt instead of silent error
status: approved
version: 0.2.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.4
layer: permissions
depends_on: [SPEC-401, SPEC-404, SPEC-301, SPEC-801]
blocks: [SPEC-826]
estimated_loc: 140
files_touched:
  - src/tools/executor.ts
  - src/tools/loopAdapter.ts
  - src/permissions/gate.ts
  - src/channels/cli/repl.ts
  - src/channels/cli/render.ts
  - src/channels/cli/slashAutocomplete.ts
  - tests/permissions/gate.test.ts
  - tests/tools/loopAdapter.test.ts
  - tests/channels/cli/repl.prompt.test.ts
  - tests/channels/cli/repl.confirmReplExit.test.ts
---

# Confirm flow wiring — destructive tools prompt instead of silent error

## 1. Outcomes

- Destructive tools (Write/Edit/MultiEdit/Bash/NotebookEdit) in `default` mode prompt y/n/always/never inline instead of silently erroring
- `/mode acceptEdits` fast-path actually fires: Write auto-allows, Bash still prompts
- Duplicate `[TOOL]` render eliminated — only one emission per tool invocation
- User workflow: `viết file bot.py nội dung X` → inline `? Cho em ghi bot.py? [Y/n/always/never]` → action runs

## 2. Scope

### 2.1 In-scope

- `LoopAdapterOptions.onAsk?: (inv) => Promise<'allow'|'deny'|'always'>` callback
- REPL wires `onAsk` to `confirm()` in `src/channels/cli/confirm.ts`
- Executor populates `sideEffects` from tool metadata when calling `canUseTool` (mirrors `loopAdapter.effectOf`)
- Render suppresses `content_block_start` tool emission (line 75-77); keep only `tool_start` from loop
- `always` decision persists per-session via `gate.rememberAllow`

### 2.2 Out-of-scope (defer to other specs)

- Cross-session allow list → v0.4 (needs persistence design)
- Rule-authoring UX → v0.4
- Multi-pane confirm modal (TUI complexity) → deferred indefinitely

## 3. Constraints

### Technical

- Inline prompt (1-line y/n/always/never) — no full-screen modal
- Confirm during stream: buffer tool execution until confirm resolves; do not race with streaming
- Non-interactive TTY: fall back to existing error path (`T_PERMISSION`) — scripts remain predictable
- No API break: `runTurn` signature unchanged externally (`onAsk` is loop-internal)
- Bun ≥1.2, TypeScript strict, no `any`, max 400 LoC per file

### Performance

- Confirm round-trip <500ms user-perceived (readline native, no extra deps)
- No allocations in the `allow` fast-path after `rememberAllow` is set

### Resource / Business

- 1 dev part-time; inline prompt avoids TUI dependency (readline-native sufficient)

## 4. Prior Decisions

- **Adapter-level `onAsk` (not executor-level)** — keeps executor sync + deterministic; UX layer owns interaction. Matches Claude Code pattern where the loop adapter mediates between tool execution and channel UX.
- **Inline prompt, not modal** — terminal UX simpler; avoids TUI dep; readline-native is enough for y/n/always/never.
- **Confirm on `tool_start` pre-execute** — after stream buffer complete, before I/O begins; avoids interrupting the streaming phase.
- **`always` = session-scoped** — not cross-session; symmetric with `never`; v0.4 adds persistence.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `loopAdapter.ts` — add `onAsk` option; when gate returns `'ask'`, invoke `onAsk(inv)`; on `'allow'`/`'always'` → `rememberAllow` (always-case) then execute; on `'deny'` → synthesize `T_PERMISSION:user_denied` tool_result | unit test with stub `onAsk` | 40 | — |
| T2 | `executor.ts` — populate `sideEffects` from tool metadata when calling `canUseTool` (mirror `effectOf`) | test: `canUseTool` spy asserts `sideEffects` present; acceptEdits auto-allows Write | 15 | T1 |
| T3 | `repl.ts` — provide `onAsk` bridge to `confirm()`; humanized prompt string | integration test with stdin pipe | 30 | T1 |
| T4 | `render.ts` — remove `content_block_start` tool emission (line 75-77); keep only `tool_start` | snapshot test shows single emission | 5 | — |
| T5 | Tests — gate acceptEdits matrix; repl confirm y/n/always roundtrip; render dedup | all pass | 30 | T2, T3, T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/permissions/gate.test.ts`: `canUseTool({name:'Write', sideEffects:'write'}, {mode:'acceptEdits'})` === `'allow'`
- `executor.test.ts`: spy on `Gate.canUseTool`; assert `sideEffects` field is present and matches `effectOf(tool)`

### 6.2 Integration Tests

- `tests/channels/cli/repl.prompt.test.ts`: pipe `"write hello to tmp.txt\ny\n"` → Write fires and file created; pipe `"...n\n"` → tool_result contains `T_PERMISSION:user_denied` and no file written

### 6.3 Smoke Tests

- Compile binary (`bun run compile:linux-x64`), run `./dist/nimbus-linux-x64` in default mode, attempt `viết file test.txt nội dung hello` → y/n prompt appears → file written on `y` → no file on `n`

## 7. Interfaces

```ts
// loopAdapter.ts — extended options
export interface LoopAdapterOptions {
  mode: PermissionMode;
  onAsk?: (inv: ToolInvocation) => Promise<'allow' | 'deny' | 'always'>;
}

// confirm.ts (existing, now called from repl.ts)
export async function confirm(question: string): Promise<'allow' | 'deny' | 'always' | 'never'>;
```

## 8. Files Touched

- `src/tools/executor.ts` (modify ~15 LoC — populate `sideEffects` in `canUseTool` call)
- `src/tools/loopAdapter.ts` (modify ~40 LoC — add `onAsk` option + gate bridge)
- `src/channels/cli/repl.ts` (modify ~30 LoC — wire `onAsk` to `confirm()`)
- `src/channels/cli/render.ts` (modify ~5 LoC — remove duplicate `content_block_start` tool emit)
- `tests/permissions/gate.test.ts` (modify ~15 LoC — acceptEdits matrix)
- `tests/channels/cli/repl.prompt.test.ts` (new, ~15 LoC — y/n/always roundtrip)

## 9. Open Questions

- [ ] `'never'` decision scope: kill rule for session or global? — current decision: session only, matches `'always'` symmetry; revisit in v0.4 persistence design

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.2 fix for user-caught LIVE bug (3ms silent error on Write in default mode); wires existing `confirm()` to loop adapter; populates `sideEffects` for acceptEdits fast-path
- 2026-04-16 @hiepht: v0.3.4 **Bug B fix** — two wire defects prevented the
  confirm `y` from actually re-executing the tool:
  1. `gate.ts::decideByMode` only consulted the session allow-cache when a
     rule matched with decision `'ask'`. The destructive-tool fallback
     (`DESTRUCTIVE_TOOLS.has(inv.name) → 'ask'`) ignored the cache entirely,
     so even after `rememberAllow()` the second `canUseTool` still returned
     `'ask'`. Fixed by adding a pre-fallback cache probe.
  2. `loopAdapter.ts::execute` only called `rememberAllow` for the `'always'`
     decision. The more common `'allow'` (user answered `y`) skipped
     `rememberAllow` and re-ran `runOnce` which hit the same fresh gate →
     another `needs_confirm` error. In v0.3 there is no cross-session
     persistence (§2.2), so `'allow'` and `'always'` are equivalent within a
     session; both now `rememberAllow`. Cross-session distinction lands in
     v0.4 persistence design.
  Net user impact: confirm flow now actually writes the file. Regression
  tests cover both `'allow'` and `'always'` plus the gate-fallback cache.
- 2026-04-16 @hiepht: v0.3.5 **URGENT fix — REPL exited after tool confirm**.
  After a successful `y` confirm + tool completion, the CLI silently exited
  back to the shell mid-REPL. Root cause: `makeOnAsk` used
  `node:readline.createInterface({terminal:false})` to read the y/n token.
  `readline.close()` explicitly pauses the underlying stream (documented
  Node behaviour, preserved in Bun 1.3). When control returned to the
  outer `slashAutocomplete.readLine()` which re-enabled raw mode and
  attached a `'data'` listener, stdin stayed paused — `on('data', ...)`
  does not auto-resume an explicitly paused stream. With no pending I/O,
  Bun emptied the event loop and exited with code 0. User saw the shell
  prompt return after `✓ done`.
  Fix: (1) rewrite `makeOnAsk` to read the confirm token via a raw-mode
  `'data'` listener directly — no inner readline, no pause. (2) Defence
  in depth: `slashAutocomplete.readLine()` now always calls
  `input.resume()` after attaching its data listener so the REPL
  recovers even if any other code path pauses the stream.
  Regression tests: `tests/channels/cli/repl.confirmReplExit.test.ts`
  covers the confirm-then-re-read cycle, the resume-on-entry contract,
  and the paused-stream recovery path.
