---
id: SPEC-141
title: MemoryRecall BM25 — lexical query over MEMORY + sessions
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P2, P3]
depends_on: [SPEC-104, SPEC-102, SPEC-105, SPEC-151]
blocks: [SPEC-139]
estimated_loc: 180
files_touched:
  - src/context/memoryRecall.ts
  - src/context/recallIndex.ts
  - src/core/promptSections.ts
  - tests/context/memoryRecall.test.ts
  - tests/e2e/memory-recall.test.ts
---

# MemoryRecall BM25 — Lexical Query over MEMORY + Sessions

## 1. Outcomes

- Instead of dumping the entire MEMORY.md (+ trimmed recent sessions) into every prompt, nimbus injects only the top-K bullets relevant to the current user turn.
- Recall uses BM25 lexical ranking over an in-process `bun:sqlite` FTS5 index rebuilt lazily when MEMORY.md changes.
- Prompt size for a typical query drops from ~4KB (full memory) to ~800B (top-8 bullets), saving ~15-30% on per-turn input tokens for memory-heavy workspaces.
- Next-session recall quality (measured by eyeball relevance on fixture dataset of 30 "user asked about X → agent needed past bullet Y") ≥70% top-3.
- Half of P2 vision (recall); the other half — consolidated writing of new memory — is already shipped in SPEC-112 Dreaming Lite + SPEC-304 MemoryTool.

## 2. Scope

### 2.1 In-scope

- `MemoryIndex` over `MEMORY.md` + last N=5 `session-*.jsonl` files (summaries only, not raw tool outputs).
- BM25 scoring via `bun:sqlite` FTS5 virtual table. No external ML/embedding deps.
- Auto-rebuild trigger: file mtime change on `MEMORY.md` → mark dirty → rebuild on next `query()`.
- Query API: `recall({ query, k = 8, workspaceId, sources })` → `Array<{ text, score, source, createdAt }>`.
- Prompt injection point: replace "full memory dump" block in SPEC-105 prompt backbone with `recallAndFormat()` when recall is enabled.
- Config flag `memory.recall.enabled = true` default-on for new workspaces; existing workspaces stay on full-dump until migrated (SPEC-501 profile key).
- Fallback: if FTS5 unavailable (ancient Bun) or index corrupt → fall back to full-dump, log warn, emit `I_RECALL_FALLBACK` info.

### 2.2 Out-of-scope (defer)

- Embedding-based semantic recall → v0.6+ (BM25 is the "prove-it-works" baseline; add vector only if telemetry shows recall <60% quality).
- Recall tuning UI (user adjusts K, filters by recency) → v0.5 polish.
- Cross-workspace recall → out of scope forever (workspace isolation is a META-001 invariant).
- Recall over tool outputs / code blobs → v0.5 (v0.4 indexes bullets + summaries only).

## 3. Constraints

### Technical

- `bun:sqlite` FTS5 (built-in; Bun ≥1.2 has it).
- Index stored at `~/.nimbus/workspaces/<id>/recall.db`; mode 0600.
- Re-index full MEMORY.md if <2MB; incremental otherwise (unlikely — bullet files rarely exceed 500KB).
- Tokenizer: FTS5 default `unicode61` (case+diacritic folding). Good enough for en/vi mixed text per SPEC-180 i18n.
- No Zod at query time — BM25 path is a hot path; validate only at boundary (public API).

### Performance

- Index rebuild for 1MB MEMORY.md <200ms.
- Query latency <15ms p95 for K=8 against 1000-bullet index.
- Added per-turn overhead: <20ms vs full-dump (<5ms for warm index, +rebuild cost only when dirty).

### Resource

- Disk: recall.db typically ~1.5× MEMORY.md size. Capped at 50MB (refuse to index beyond; log warn).
- Memory: FTS5 prepared statement + query ≤ 500KB resident.

## 4. Prior Decisions

- **BM25 over embeddings for v0.4** — Expert B proposed vector store; Expert C argued lexical sufficient; mediator ruled BM25 first, embeddings only if measured-need. Zero new deps beats shiny.
- **FTS5 over in-memory invindex** — sqlite FTS5 is battle-tested, crash-safe, survives restart. Custom inverted index is ~200 LoC of novel code for no material gain.
- **Index bullets + session summaries only, not raw tool outputs** — raw outputs pollute recall with code dumps; summaries (from SPEC-112 Dreaming) are already distilled.
- **Default-on for new workspaces, opt-in migration for existing** — avoids retroactive surprise for users with carefully curated MEMORY.md + prompts depending on full-dump.
- **Fallback to full-dump on index failure** — never degrade below current behavior; log warn + recover.
- **No new cost attribution** — recall is local-only, zero LLM spend. SPEC-701 unchanged.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | FTS5 schema + index creation | `init(workspaceId)` creates `recall.db` with `bullets(rowid, text, source, createdAt)` FTS5 table; idempotent | 40 | SPEC-151 |
| T2 | Indexer: parse MEMORY.md bullets + session summaries → rows | 1000 bullets indexed in <200ms; mtime tracked | 50 | T1, SPEC-104, SPEC-102 |
| T3 | `query(text, k)` with BM25 ranking | Returns top-K with score descending; ties broken by recency | 35 | T1 |
| T4 | Prompt-backbone integration | `recallAndFormat(query, k)` replaces full-dump when enabled; fallback path tested | 30 | T3, SPEC-105 |
| T5 | Config flag + migration | `memory.recall.enabled` in `workspace.json`; new workspaces default true | 15 | SPEC-501 |
| T6 | Fallback + telemetry | `I_RECALL_FALLBACK` event on index failure; full-dump resumed | 10 | T4, SPEC-118 |

## 6. Verification

### 6.1 Unit Tests

- Index 10 fixture bullets → query matches expected top-3 for 5 seed queries.
- MEMORY.md mtime change → next query triggers rebuild (verified via spy).
- Corrupt recall.db → fallback fires, full-dump returned, warn logged.
- Tokenizer folds Vietnamese diacritics: query "qui trinh" matches bullet "quy trình".
- K=8 against 1000-bullet index: <15ms (bench).
- Query with zero matches → returns empty array, no fallback triggered.

### 6.2 E2E Tests

- `tests/e2e/memory-recall.test.ts`: seed workspace with 30-entry MEMORY.md, run REPL query "what do you remember about project X?", assert injected prompt block contains relevant 3-5 bullets and NOT the full 30.
- Measure prompt token delta: 30-bullet fixture, full-dump ~3.2KB → BM25 recall ~0.7KB.

### 6.3 Performance Budgets

- Rebuild 1MB MEMORY.md <200ms.
- Query <15ms p95 at K=8, N=1000.
- Per-turn overhead budget <20ms (rebuild amortized).

### 6.4 Security Checks

- `recall.db` created with mode 0600 (META-009 storage rule).
- Path traversal: workspaceId validated via existing `resolveWorkspacePath` (SPEC-101); no untrusted input to `bun:sqlite` open.
- FTS5 query parametrization only — no raw interpolation (SQL injection moot on local file but principle holds).
- No secret-shaped strings surfaced: same scrubber as MemoryTool (SPEC-304).

## 7. Interfaces

```ts
import { z } from 'zod'

export const RecallQuerySchema = z.object({
  query: z.string().min(1).max(512),
  k: z.number().int().min(1).max(32).default(8),
  workspaceId: z.string(),
  sources: z.array(z.enum(['memory', 'session-summary'])).default(['memory', 'session-summary']),
})
export type RecallQuery = z.infer<typeof RecallQuerySchema>

export const RecallHitSchema = z.object({
  text: z.string(),
  score: z.number(),
  source: z.enum(['memory', 'session-summary']),
  sourceRef: z.string(),   // e.g., 'MEMORY.md#L42' or 'session-2026-04-16.jsonl#turn-7'
  createdAt: z.string(),   // ISO
})
export type RecallHit = z.infer<typeof RecallHitSchema>

export interface MemoryRecall {
  recall(q: RecallQuery): Promise<RecallHit[]>
  reindex(workspaceId: string, force?: boolean): Promise<{ indexed: number; durationMs: number }>
  isEnabled(workspaceId: string): boolean
}

export type RecallEvent =
  | { type: 'recall.query'; workspaceId: string; k: number; hits: number; durationMs: number }
  | { type: 'recall.fallback'; workspaceId: string; reason: 'no_fts5' | 'corrupt' | 'error' }
```

## 8. Files Touched

- `src/context/memoryRecall.ts` (new, ~90 LoC — public API)
- `src/context/recallIndex.ts` (new, ~90 LoC — FTS5 persistence)
- `src/core/promptSections.ts` (edit, +30 LoC — swap full-dump for recall when enabled)
- `tests/context/memoryRecall.test.ts` (new, ~180 LoC)
- `tests/e2e/memory-recall.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Surface a `/recall <query>` slash command for debugging? (lean yes — trivial wiring, devs benefit; put under `--debug recall` to stay user-clean)
- [ ] Recall-quality telemetry — log the top-K scores so we can measure "median top-1 score" trend over time? (lean yes; 5-min work; informs v0.6 embedding decision)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — Phase 2 mediator ruling (BM25 v0.4, embeddings v0.6+). Unblocks SPEC-139 LearningEngine.
