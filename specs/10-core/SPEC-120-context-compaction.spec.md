---
id: SPEC-120
title: Context compaction — full + micro + sliding window
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.2
layer: core
depends_on: [SPEC-103, SPEC-201, SPEC-202, SPEC-203, SPEC-105]
blocks: []
estimated_loc: 530
files_touched:
  - src/context/tokens.ts
  - src/context/compactPrompt.ts
  - src/context/compact.ts
  - src/context/microCompact.ts
  - src/context/slidingWindow.ts
  - tests/context/compact.test.ts
  - tests/context/microCompact.test.ts
---

# Context compaction — full + micro + sliding window

## 1. Outcomes

- Long conversations don't blow context window — auto-compact fires before limit
- 9-section structured summary preserves intent, decisions, and active work across compaction
- Provider-aware micro-compact surgically removes stale tool results without cache invalidation (Anthropic)
- Sliding window fallback ensures agent always has a response path even when compact itself is too expensive

## 2. Scope

### 2.1 In-scope

- **Token estimation**: `roughTokenCount(text)` (~4 chars/token, 4/3 conservative padding), `effectiveWindow(model)` = contextWindow - min(maxOutput, 20K), images at 2000 tokens flat
- **Full compact**: triggered when tokenUsage > 80% of effectiveWindow OR `/compact` slash. Forked summarization call (reuses prompt cache prefix). 9-section summary prompt with `<analysis>` scratchpad (stripped before insertion). Post-compact restoration: top-5 recently-read files (50K token budget, 5K/file) + active plan + workspace memory refs. `CompactBoundaryMessage` marker with metadata (trigger, pre-token-count, preserved segments). Circuit breaker: 3 consecutive failures → stop auto-compact.
- **Micro compact**: per-turn before API call. Provider-aware: Anthropic uses `cache_edits` API to surgically remove old tool_result IDs without cache invalidation; OpenAI-compat uses direct content mutation (replace with `[cleared]`). Time-based trigger for cold cache (gap > threshold). Compactable tools: Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write.
- **Sliding window**: fallback when full compact itself would exceed budget or provider has no summarization capability. Keep last N messages + system prompt, drop everything older.
- **No tool use during compaction**: forked summarization call has `canUseTool: deny` — prevents model from calling tools in compact pass.

### 2.2 Out-of-scope

- Memory consolidation (SPEC-112 Dreaming Lite — separate concern)
- Semantic compression / embedding-based retrieval (v0.5 RAG)
- Cross-session compaction (sessions are independent)

## 3. Constraints

### Technical
- Bun-native, TypeScript strict, no `any`, max 400 LoC per file
- Compact prompt must be cacheable (stable prefix for Anthropic prompt caching)
- `CompactBoundaryMessage` must be valid CanonicalBlock (extend SPEC-201 if needed)

### Performance
- Full compact: <5s for 50K-token conversation (LLM-bound)
- Micro compact: <10ms (pure CPU, no LLM call)
- Sliding window: <1ms
- Token estimation: <2ms for 100K chars

## 4. Prior Decisions

- **9-section summary** — adopted from Claude Code (src/services/compact/prompt.ts). Sections: Primary Request, Key Technical Concepts, Files and Code, Errors and Fixes, Problem Solving, All User Messages, Pending Tasks, Current Work, Optional Next Step. Proven effective across 1000+ sessions.
- **`<analysis>` scratchpad** — chain-of-thought before summary improves quality. Stripped before insertion (user never sees it). Claude Code pattern.
- **Post-compact file restoration** — without it, model re-reads everything. Claude Code learned this the hard way. Budget: 50K tokens for top-5 recent files.
- **Provider-aware microcompact** — Anthropic `cache_edits` preserves prompt cache (saves $). OpenAI-compat: direct mutation acceptable since no explicit cache.
- **Circuit breaker at 3 failures** — prevents infinite compact-retry loops. Claude Code data: 1,279 sessions hit this.
- **No tool use in compact** — Claude Code found Sonnet 4.6+ attempts tool calls during compaction despite instructions. Hard deny required.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Token estimation utility | roughTokenCount, effectiveWindowSize, image estimation, threshold calc | 60 | — |
| T2 | Compact prompt template (9 sections) | formatCompactPrompt returns cacheable string, analysis scratchpad stripped | 80 | — |
| T3 | fullCompact | boundary markers, forked summarization, post-compact restoration, circuit breaker | 200 | T1,T2 |
| T4 | microCompact | provider-aware (Anthropic cache_edits vs OpenAI content-clear), time-based trigger | 100 | T1 |
| T5 | slidingWindow | keep last N + system prompt, drop older | 50 | T1 |
| T6 | Agent loop integration | auto-compact check per-turn, /compact handler, CompactBoundaryMessage in IR | 40 | T3,T4,T5 |

## 6. Verification

### 6.1 Unit Tests
- Token estimation: known-length strings, images, mixed content
- Compact prompt: 9 sections present, analysis stripped, cacheable prefix
- Full compact: boundary marker inserted, restored files present, circuit breaker triggers at 3
- Micro compact: Anthropic path uses cache_edits, OpenAI path mutates content
- Sliding window: keeps exactly last N, system prompt preserved

### 6.2 E2E Tests
- 50K-token conversation → auto-compact fires → session continues with summary
- `/compact` manual trigger → boundary marker visible in session

### 6.3 Performance Budgets
- Micro compact <10ms (bench)
- Token estimation <2ms for 100K chars (bench)

## 7. Interfaces

```ts
interface CompactBoundaryMessage {
  type: 'compact_boundary';
  summary: string;
  metadata: {
    trigger: 'auto' | 'manual';
    preTokenCount: number;
    postTokenCount: number;
    preservedSegments?: string[];
  };
}

function roughTokenCount(text: string): number;
function effectiveWindow(model: string, maxOutput: number): number;
function fullCompact(messages: CanonicalMessage[], opts: CompactOpts): Promise<CompactResult>;
function microCompact(messages: CanonicalMessage[], provider: ProviderKind): CanonicalMessage[];
function slidingWindow(messages: CanonicalMessage[], budget: number): CanonicalMessage[];
```

## 8. Files Touched

- `src/context/tokens.ts` (new, ~60 LoC)
- `src/context/compactPrompt.ts` (new, ~80 LoC)
- `src/context/compact.ts` (new, ~200 LoC)
- `src/context/microCompact.ts` (new, ~100 LoC)
- `src/context/slidingWindow.ts` (new, ~50 LoC)
- `tests/context/compact.test.ts` (new, ~150 LoC)
- `tests/context/microCompact.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should compact summary include code snippets or just file:line references? (Claude Code includes snippets — adopt)
- [ ] Partial compact (keep prefix for cache) — implement in v0.2 or defer? (defer to v0.2.1)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on Claude Code compaction reverse-engineering (src/services/compact/ reference)
