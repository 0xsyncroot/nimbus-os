---
id: SPEC-116
title: Thinking traces capture — record extended thinking blocks
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.2
layer: core
depends_on: [META-004, SPEC-102, SPEC-202]
blocks: []
estimated_loc: 80
files_touched:
  - src/context/thinkingCapture.ts
  - tests/context/thinkingCapture.test.ts
---

# Thinking Traces Capture

## 1. Outcomes

- When the active Anthropic model supports extended thinking (Sonnet 4.5+, Opus 4.6+), nimbus requests thinking blocks and stores them in session `events.jsonl` distinctly from user-visible assistant content
- Users opt in to display via `/show-thinking` (off by default); off-screen capture always happens when the model supports it
- Other providers (OpenAI/Groq/DeepSeek/Ollama) — thinking field absent or normalized to empty per META-004; no crash
- Debugging self-healing and post-mortem root-cause gets access to the model's chain-of-thought without cluttering the live REPL

## 2. Scope

### 2.1 In-scope
- Detect model capability: enable thinking param for Anthropic models on allowlist (`sonnet-4-5`, `sonnet-4-6`, `opus-4-6`, plus glob `*-thinking` for future)
- Pass `thinking: { type: 'enabled', budget_tokens: N }` to Anthropic SDK per SPEC-202; default `N = 2048`, configurable via `thinking.budgetTokens`
- Consume streaming `thinking_delta` events; accumulate into canonical IR `ThinkingBlock` (META-004 reserves this)
- Persist thinking blocks to session `events.jsonl` with event type `thinking.block` (separate from `assistant.text`)
- REPL rendering: NOT shown by default; `/show-thinking on` toggles inline dim-colored render; `/show-thinking off` reverts
- Cost attribution: thinking tokens counted under `reasoningTokens` in CostEvent (SPEC-701) and in TurnMetric.tokens

### 2.2 Out-of-scope
- Search/grep over thinking history UI → v0.3 `nimbus trace` CLI
- Thinking-aware compaction (summarizing thinking separately) → v0.5
- OpenAI o-series reasoning tokens — separate capture path, tracked in SPEC-203 (this spec is Anthropic-focused)

## 3. Constraints

### Technical
- Zero behavior change when model doesn't support thinking (capability guard mandatory)
- Thinking blocks NEVER forwarded to next provider turn as user-visible context (they're opaque to the model; echoing wastes tokens)
- `events.jsonl` append uses existing SPEC-102 writer; adds one new event type, no schema migration needed (JSONL forward-compat)

### Performance / Cost
- Thinking budget default 2048 tokens; overhead <2s added to first-token latency in practice
- Capture overhead <0.5ms per delta (simple string buffer accumulation)

## 4. Prior Decisions

- **Off by default in REPL** — thinking is verbose and confusing for first-run users; capture silently so debug has data, display only on request
- **Persist to events.jsonl not messages.jsonl** — META-004 treats thinking as metadata about a turn, not user-visible conversational content; keeping them separate prevents accidental prompt inclusion
- **reasoningTokens cost field shared with o-series** — single cost accounting path regardless of provider; documented mapping in SPEC-701 price table
- **Budget 2048 default** — Anthropic docs recommend 1024-8192 range; 2K is mid-ground for v0.2 REPL work without blowing latency

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Capability detect + request toggle | Only fires for allowlisted Anthropic models | 15 | SPEC-202 |
| T2 | Stream consumer for `thinking_delta` | Accumulates full block; handles multi-part | 25 | SPEC-201 |
| T3 | Persist `events.jsonl` with new type | Single JSONL line per block; schemaVersion preserved | 20 | SPEC-102 |
| T4 | `/show-thinking on|off` slash + render | Dim color; no effect when no thinking in session | 20 | SPEC-801 |

## 6. Verification

### 6.1 Unit Tests
- Capability: `sonnet-4-6` → enabled; `gpt-4o` → disabled (no param in request)
- Stream: 3 `thinking_delta` events → 1 consolidated `ThinkingBlock`
- Persist: event written with `type: 'thinking.block'`, `sessionId`, `turnId`, `schemaVersion: 1`
- Cost: reasoningTokens field populated; total usd includes thinking price per table
- `/show-thinking on` then new turn → REPL output includes dim-rendered thinking prefix; `off` then new turn → absent

### 6.2 E2E Tests
- `tests/e2e/thinking-capture.test.ts`: sonnet-4-6 turn → events.jsonl has 1 thinking block; messages.jsonl has only assistant.text + user.text (no leak)

### 6.3 Performance Budgets
- Capture overhead <0.5ms/delta; first-token latency not regressed beyond thinking budget-driven added time

### 6.4 Security Checks
- Thinking blocks NEVER echoed back to provider in subsequent turns (assert IR serializer excludes them from outbound prompt)
- Thinking blocks NEVER written to logs with `logger.info` — only to events.jsonl (keeps chain-of-thought out of log aggregators)

## 7. Interfaces

```ts
export const ThinkingBlockSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  turnId: z.string(),
  sessionId: z.string(),
  type: z.literal('thinking.block'),
  content: z.string(),
  tokenCount: z.number(),
})
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>

export interface ThinkingCapture {
  supportsThinking(provider: string, model: string): boolean
  buildRequestParams(model: string): { thinking?: { type: 'enabled'; budget_tokens: number } }
  onStreamDelta(delta: unknown, ctx: TurnContext): void
  flushBlock(ctx: TurnContext): Promise<ThinkingBlock | null>
  setDisplayMode(mode: 'on' | 'off'): void
}
```

## 8. Files Touched

- `src/context/thinkingCapture.ts` (~70 LoC)
- `tests/context/thinkingCapture.test.ts` (~120 LoC)

## 9. Open Questions

- [ ] Budget auto-scale by model class? (workhorse=2K, reasoning=8K) — lean yes v0.3
- [ ] Redact SENSITIVE_FIELDS within thinking blocks too? (v0.3 extension; v0.2 assumes model doesn't echo user secrets into thinking)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
