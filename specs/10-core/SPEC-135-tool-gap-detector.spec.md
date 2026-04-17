---
id: SPEC-135
title: ToolGapDetector — trap unknown tool calls, offer synthesis
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P5, P8]
depends_on: [SPEC-103, SPEC-301, SPEC-118, SPEC-401, META-003]
blocks: [SPEC-136]
estimated_loc: 250
files_touched:
  - src/core/toolGap/detector.ts
  - src/core/toolGap/promptFragment.ts
  - src/tools/executor.ts
  - src/core/promptSections.ts
  - tests/core/toolGap/detector.test.ts
  - tests/e2e/tool-gap.test.ts
---

# ToolGapDetector — Trap Unknown Tool Calls, Offer Synthesis

## 1. Outcomes

- When the agent requests a tool name NOT in the registry, the executor traps the call (instead of raising an opaque `U_TOOL_NOT_FOUND`) and surfaces a structured "tool gap" event.
- Gap event contains: requested `toolName`, intended `args`, normalized `capability` guess (e.g., `send_telegram_message`), and `suggestedAction: 'synthesize' | 'existing_tool' | 'decline'`.
- User sees a clear inline message: *"Agent tried to use `telegram_bot` which doesn't exist. Closest existing tool: `telegram.send`. Use it? [y] / Synthesize new tool? [s] / Cancel [n]"*.
- The hard-coded anti-bandaid in `promptSections.ts:74` ("NEVER create telegram_bot.py…") is deleted once this ships + 1 release burn-in.
- First half of P5 vision: **detection**. Synthesis half lives in SPEC-136.

## 2. Scope

### 2.1 In-scope

- Hook in `tools/executor.ts` before dispatch: if `registry.get(toolName)` returns undefined → emit `tool.gap` event on SPEC-118 bus and return structured `ToolGapResult` to loop instead of raw error.
- `normalizeCapability(toolName, args)`: heuristic + regex mapping from hallucinated name → canonical capability string (e.g., `telegram_bot` → `channel.send.telegram`).
- `findNearest(capability)`: fuzzy search existing registry for 1-3 candidates (Levenshtein on name, substring on description).
- Prompt fragment injected when gap fires: tells the agent "the tool X does not exist; these exist: [...]; user decides next step." — agent retries with suggested tool or exits gracefully.
- User-facing choice UI in CLI REPL (`SPEC-801`): `y/s/n` prompt rendering.
- Audit entry `tool.gap.detected` with jobId linkage (if fired inside cron handler).
- Rate limit: max 3 gap events per session → circuit break to prevent infinite synthesis loops (user must `/reset-gap-counter`).

### 2.2 Out-of-scope (defer)

- Actual synthesis of the missing tool → SPEC-136 ToolBuilder.
- Confirmation UI in non-CLI channels (Telegram/Slack approve synthesis) → SPEC-144 Plan-diff UI.
- Cross-session gap pattern tracking ("same gap 3 times → auto-synthesize") → SPEC-137 PatternObserver.
- LLM-based capability classifier (regex is enough for v0.4) → v0.5 if accuracy measured <70%.

## 3. Constraints

### Technical

- Pure in-process; no network calls during detection.
- Must not break existing `U_TOOL_NOT_FOUND` error semantics for callers who deliberately want the error (keep a `ToolExecutor.run({ trapGap: false })` escape hatch; default true).
- Gap event payload ≤ 2KB (args truncated if larger, with `argsTruncated: true` flag).
- Levenshtein distance computed only against tool NAMES (≤200 tools, O(N×M) where M≈50 chars fine).

### Performance

- Gap detection overhead <5ms per trapped call.
- FindNearest <10ms for 200 registered tools.

### Resource

- No new dependencies. Levenshtein ~30 LoC inline.

## 4. Prior Decisions

- **Trap at executor, not at planner.** Planner-level detection (inspect SPEC-132 TodoWrite output for capability words) was debated with Expert B. Executor trap is cheapest (~60 LoC), catches the actual failure mode (model hallucinates tool call), and defers planner-level inspection to v0.5 once we have real data on miss frequency.
- **No LLM classifier for capability normalization** — regex + mapping table is ~80% accurate per similar tooling in Claude Code. If accuracy proves insufficient, promote to LLM in v0.5.
- **Rate limit at 3 per session** — prevents "agent fights the gap" infinite loop; user-resettable for legitimate exploration.
- **Kill prompt bandaid after 1 release** — per mediator ruling (Phase 5 of synthesis). Delete `promptSections.ts:74` NEVER-rule in v0.4.1, not v0.4.0 (one-release overlap for safety).
- **Inline `y/s/n` prompt, not full diff UI** — SPEC-144 is v0.5; v0.4 ships with minimal CLI prompt; Telegram users get a stub "gap detected, open CLI to resolve" until SPEC-144 lands.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Detector core + `ToolGapResult` type | Executor returns gap result when tool unknown; existing tools unaffected | 70 | — |
| T2 | `normalizeCapability` heuristic + mapping table | 10 fixture hallucinations → correct canonical; unknown → returns raw | 50 | T1 |
| T3 | `findNearest` + inline Levenshtein | Returns 1-3 candidates sorted by distance; empty when no match <0.6 | 40 | — |
| T4 | REPL `y/s/n` prompt wiring | User choice propagated back into loop; `s` writes `action: 'synthesize'` for SPEC-136 to pick up | 40 | SPEC-801, T1 |
| T5 | Audit + event bus integration | `tool.gap.detected` emitted; audit entry written; rate-limit 3/session | 25 | SPEC-118, SPEC-119, T1 |
| T6 | Delete `promptSections.ts:74` bandaid + regression test | Removed in same commit; test asserts it's gone; gap-handler covers the case | 25 | T1 |

## 6. Verification

### 6.1 Unit Tests

- Executor with unknown tool name + trap enabled → returns `ToolGapResult`, no throw.
- Executor with unknown tool + `trapGap: false` → throws `U_TOOL_NOT_FOUND` (backward compat).
- `normalizeCapability('telegram_bot', {text:'hi'})` → `'channel.send.telegram'`.
- `normalizeCapability('run_python', {code:'...'})` → `'shell.exec'`.
- `findNearest('telegrom', registry with telegram.send)` → distance 1, returned first.
- Rate limit: 4th gap in same session → `NimbusError(P_GAP_LIMIT)`.
- Audit entry shape matches SPEC-119 contract.

### 6.2 E2E Tests

- `tests/e2e/tool-gap.test.ts`: run compiled binary with mocked provider emitting hallucinated `telegram_bot` tool_use → REPL prints gap prompt → user answers `y` + picks `telegram.send` → agent retries successfully.
- Same fixture, answer `n` → agent exits gracefully with "cancelled" message, no tool called.
- Fixture asserting no regression of "hallucinated python runner" pattern from v0.3.6.

### 6.3 Performance Budgets

- Gap detection <5ms p99.
- FindNearest <10ms for 200-tool registry.

### 6.4 Security Checks

- Gap prompt injected to model MUST be tagged as system-boundary (uses SPEC-105 protected injection path). Prevents prompt-injection via user input that mentions fake tool names.
- Truncated args never include raw secret values: reuse SENSITIVE_FIELDS scrubber from `src/core/credentialDetector.ts`.
- Audit entry never logs raw args, only `argsHash`.

## 7. Interfaces

```ts
import { z } from 'zod'

export const ToolGapResultSchema = z.object({
  gap: z.literal(true),
  requestedTool: z.string(),
  capability: z.string().nullable(),
  nearest: z.array(z.object({
    name: z.string(),
    distance: z.number(),
    description: z.string(),
  })).max(3),
  argsHash: z.string(),
  argsTruncated: z.boolean(),
})
export type ToolGapResult = z.infer<typeof ToolGapResultSchema>

export interface ToolGapDetector {
  trap(toolName: string, args: unknown): ToolGapResult | null
  normalizeCapability(toolName: string, args: unknown): string | null
  findNearest(capability: string, registry: ToolRegistry): ToolGapResult['nearest']
  resetSessionCounter(sessionId: string): void
}

export type ToolGapEvent = {
  type: 'tool.gap.detected'
  sessionId: string
  requestedTool: string
  capability: string | null
  nearestCount: number
  atMs: number
}

export type UserGapChoice = 'use_nearest' | 'synthesize' | 'cancel'
```

## 8. Files Touched

- `src/core/toolGap/detector.ts` (new, ~90 LoC)
- `src/core/toolGap/promptFragment.ts` (new, ~40 LoC)
- `src/core/toolGap/mapping.ts` (new, ~40 LoC — capability table)
- `src/tools/executor.ts` (edit, +30 LoC trap hook)
- `src/core/promptSections.ts` (edit, -6 LoC: delete NEVER-telegram_bot line)
- `src/channels/cli/repl.ts` (edit, +25 LoC y/s/n prompt path)
- `tests/core/toolGap/detector.test.ts` (new, ~150 LoC)
- `tests/e2e/tool-gap.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] When `nearest` has 0 results AND user answers `n`, should we record this as a "legit gap to teach later" for SPEC-139 LearningEngine? (lean yes; audit entry already captures it)
- [ ] Cross-session rate-limit state — reset on daemon restart or persist? (lean reset; 3/session is session-scoped intentionally)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — synthesis Phase 3 priority spec. Addresses P5 blocker + kills the `promptSections.ts:74` bandaid per mediator ruling.
