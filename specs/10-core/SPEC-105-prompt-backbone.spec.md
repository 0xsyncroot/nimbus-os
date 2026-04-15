---
id: SPEC-105
title: Prompt backbone — cacheable prefix injection
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-004, META-005, SPEC-104, SPEC-201]
blocks: [SPEC-103]
estimated_loc: 120
files_touched:
  - src/core/prompts.ts
  - src/core/promptSections.ts
  - tests/core/prompts.test.ts
---

# Prompt Backbone (Cacheable Prefix)

## 1. Outcomes

- `buildSystemPrompt(memory, caps, ctx)` returns `CanonicalBlock[]` matching META-005 §2.5 injection order exactly — stable byte-for-byte across turns in the same session.
- Anthropic cache hit ≥90% from turn 2 onward (measured in SPEC-601) — achieved by placing `cache_control: ephemeral` breakpoint after TOOLS_AVAILABLE.
- Providers without explicit caching (`caps.promptCaching !== 'explicit'`) receive the same block sequence with `cacheHint` stripped; no feature-detection scatter in caller code.
- Output is deterministic: same inputs → identical bytes (no `new Date()` leakage, no Map iteration order dep).

## 2. Scope

### 2.1 In-scope
- 4 static sections (AUTONOMY, SAFETY, UNTRUSTED_CONTENT, TOOL_USAGE) as const strings in `promptSections.ts`.
- Assembly function splicing SOUL/IDENTITY/MEMORY/TOOLS_AVAILABLE from `WorkspaceMemory` (SPEC-104).
- Cache breakpoint placement: 1 at end of `[SOUL]+[IDENTITY]` block, 1 at end of `[TOOLS_AVAILABLE]`.
- Capabilities-aware adapter: strip `cacheHint` when `caps.promptCaching !== 'explicit'`.

### 2.2 Out-of-scope
- Dynamic `[MODE]`/`[GOALS]`/`[ENVIRONMENT]`/`[SKILLS_AVAILABLE]` sections → v0.2 (plan §16 "v0.1 simplification").
- Compact / micro-compact of messages → v0.2.
- Per-tool schema in TOOLS_AVAILABLE (v0.1 uses TOOLS.md text only; JSON-schema injection deferred v0.2 for MCP).
- Prompt diff logging (for cache debug) → v0.3 observability.

## 3. Constraints

### Technical
- Pure function: no I/O, no `Date.now()`, no randomness.
- Output type: `CanonicalBlock[]` for `CanonicalRequest.system`.
- TS strict.
- Total prompt size ≤ 32KB (warn) / 128KB (error throw `U_BAD_COMMAND`) — protects cache budget.

### Performance
- `buildSystemPrompt()` <2ms.
- No string concat inside hot loop; use array + single `join()`.

### Resource
- Const strings allocated once at module load (frozen).

## 4. Prior Decisions

- **Static text sections as const** — why not template files: load-once, no I/O, frozen means no tampering at runtime.
- **Cache breakpoint after TOOLS_AVAILABLE** — why not after SOUL: TOOLS rarely changes; putting breakpoint there extends cacheable prefix to max stable content. Confirmed by Anthropic 2026 guidance: "Place breakpoint at boundary of last stable section."
- **Separate SOUL + IDENTITY blocks with combined breakpoint 1** — why not merged: user might have only SOUL; IDENTITY absence shouldn't invalidate SOUL cache. Breakpoint placed at end of `[SOUL]+[IDENTITY]` (combined) under assumption **IDENTITY is as stable as SOUL** (user edits rare — file is role/background, not diary). If real-world IDENTITY churn observed, split into 3 breakpoints in v0.2 (SOUL | IDENTITY | TOOLS_AVAILABLE).
- **Deterministic output** — why: cache keying in Anthropic is byte-identity; any non-determinism blows hit rate.
- **No dynamic sections in v0.1** — why: GOALS/ENV require plan detector + env gatherer (v0.2 scope). Hardcoding reduces complexity for MVP.
- **32KB warn threshold** — why: empirical budget (SOUL ~4KB + MEMORY ~10KB + TOOLS ~2KB + static ~5KB = ~21KB typical). 32KB warns before cache cost becomes unreasonable.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `promptSections.ts`: 4 static const strings | `AUTONOMY`, `SAFETY`, `UNTRUSTED_CONTENT`, `TOOL_USAGE` frozen; content matches plan §16 | 40 | — |
| T2 | `buildSystemPrompt()` assembly | returns blocks in META-005 order; snapshot test locks byte-sequence | 50 | T1 |
| T3 | Cache hint toggle per capabilities | strips `cacheHint` when `caps.promptCaching !== 'explicit'` | 10 | T2 |
| T4 | Size guard 32KB warn / 128KB throw | warn via logger, throw `NimbusError(U_BAD_COMMAND, {size})` | 20 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/prompts.test.ts`:
  - `describe('SPEC-105: prompt backbone')`:
    - Snapshot test: given fixture `WorkspaceMemory` + `caps` → byte-identical to golden file.
    - Idempotency: 2 calls with same input → `deepEqual`.
    - No-IDENTITY fixture → SOUL block present, IDENTITY absent, rest unchanged.
    - `caps.promptCaching='implicit'` → all `cacheHint` undefined.
    - `caps.promptCaching='explicit'` → 2 blocks with `cacheHint: 'ephemeral'` (after SOUL+IDENTITY, after TOOLS_AVAILABLE).
    - Oversize MEMORY (>128KB) → throws `U_BAD_COMMAND`.
    - Static section module exports wrapped in `Object.freeze(...)` where reference-type (arrays/objects); primitive strings immutable by default — assert top-level `INJECTION_ORDER` is `Object.isFrozen` true.

### 6.2 E2E Tests
- Covered transitively by SPEC-103 loop test (mocked provider records `request.system` and asserts structure).

### 6.3 Performance Budgets
- `buildSystemPrompt()` <2ms via `bun:test` bench (100 iters).

### 6.4 Security Checks
- Static section content asserted to contain `[UNTRUSTED_CONTENT]` + `trusted="false"` phrasing (T2/T3 mitigation reference).
- No user input interpolated into static sections — only SOUL/MEMORY/TOOLS bodies (already validated at SPEC-104 load).

## 7. Interfaces

```ts
// promptSections.ts
export const AUTONOMY_SECTION: string        // frozen const; plan §16 text
export const SAFETY_SECTION: string
export const UNTRUSTED_CONTENT_SECTION: string
export const TOOL_USAGE_SECTION: string

// prompts.ts
export interface BuildPromptInput {
  memory: WorkspaceMemory                    // from SPEC-104
  caps: ProviderCapabilities                 // from SPEC-201 / META-004
}

export function buildSystemPrompt(input: BuildPromptInput): CanonicalBlock[]

// Injection order constant (source of truth, referenced by tests)
export const INJECTION_ORDER = [
  'SOUL',
  'IDENTITY',
  'AUTONOMY',
  'SAFETY',
  'UNTRUSTED_CONTENT',
  'TOOL_USAGE',
  'MEMORY',
  'TOOLS_AVAILABLE',
] as const

export const PROMPT_SIZE_WARN_BYTES = 32 * 1024
export const PROMPT_SIZE_ERROR_BYTES = 128 * 1024
```

## 8. Files Touched

- `src/core/prompts.ts` (new, ~70 LoC)
- `src/core/promptSections.ts` (new, ~50 LoC — mostly const strings)
- `tests/core/prompts.test.ts` (new, ~120 LoC)
- `tests/fixtures/prompts/golden.txt` (new snapshot)

## 9. Open Questions

- [ ] Where to put language preference injection (vi vs en)? Bundle into SOUL for now; dedicated section v0.2.
- [ ] TOOLS_AVAILABLE content granularity — full body or summary? v0.1: full body (typically <2KB); v0.2 may summarize when >4KB.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
