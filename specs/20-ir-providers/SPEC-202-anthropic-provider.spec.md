---
id: SPEC-202
title: Anthropic provider adapter
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: providers
depends_on: [SPEC-201, META-003, META-004]
blocks: [SPEC-103]
estimated_loc: 200
files_touched:
  - src/providers/anthropic.ts
  - src/providers/Provider.ts
  - src/providers/registry.ts
  - tests/providers/anthropic.test.ts
---

# Anthropic Provider Adapter

## 1. Outcomes

- `bun run nimbus` with `provider: anthropic` + `ANTHROPIC_API_KEY` streams responses from Claude Sonnet/Opus/Haiku end-to-end
- Prompt cache hit ratio ≥90% on repeat turns (verified via `usage.cache_read_input_tokens`)
- Native `tool_use`/`tool_result` blocks round-trip without loss through IR
- `NimbusError(P_*)` thrown on every API failure path (network / 429 / 5xx / auth / context)

## 2. Scope

### 2.1 In-scope
- Implement `Provider` interface (SPEC-201) for `@anthropic-ai/sdk` `messages.stream`
- Map `CanonicalRequest` → Anthropic `MessageCreateParamsStreaming`
- Map Anthropic SSE events → `CanonicalChunk` stream
- Attach `cache_control: { type: 'ephemeral' }` to blocks carrying `cacheHint: 'ephemeral'` (up to 4 breakpoints)
- `capabilities()` returns Anthropic-specific flags (explicit cache, extended thinking on Sonnet/Opus)
- Error mapping: status/code → `ErrorCode.P_*`
- `countTokens(msgs)` via `client.messages.countTokens`

### 2.2 Out-of-scope (defer to other specs)
- OpenAI-compat adaption → SPEC-203
- Context compaction / cache breakpoint insertion policy → v0.2 `context/cache.ts`
- Retry/backoff — inline in v0.1 (SPEC-103); full self-heal policy → v0.2
- Vertex/Bedrock endpoints → v0.3

## 3. Constraints

### Technical
- Layer: `src/providers/anthropic/` imports ONLY `src/ir/`, `@anthropic-ai/sdk`, `zod`. NO `core/`, `tools/`, `platform/`.
- Bun-compatible (SDK uses native fetch — OK on Bun ≥1.2)
- TypeScript strict, no `any`
- Max 400 LoC per file — split `adapter.ts` (request map) / `stream.ts` (response map) / `cache.ts` (cacheHint attach) / `errors.ts` (classify)

### Performance
- First-token latency overhead <10ms over raw SDK (adapter marshalling)
- Streaming backpressure — yield to event loop every 64KB chunk

## 4. Prior Decisions

- **Use official `@anthropic-ai/sdk` not raw fetch** — handles SSE parsing, retries, type safety. Saves ~150 LoC.
- **Cap cache breakpoints at 4** (Anthropic hard limit). When `cacheHint` count >4, keep the 4 latest blocks with hint; drop hint on earlier blocks silently + warn once per session.
- **Map `{type:'thinking'}` 1:1** — Anthropic native supports thinking blocks; no transformation needed.
- **Don't auto-add cache_control** — v0.1 only attaches when `cacheHint:'ephemeral'` is explicitly on block. Policy lives in SPEC-105 prompt backbone + v0.2 cache manager.
- **Per-model capabilities, not provider-wide** — Haiku differs from Sonnet/Opus (no extended thinking, smaller context). `capabilities()` is resolved from the provider's `defaultModel` at construction. SPEC-106 model router rebuilds the provider per route. Rationale: provider-wide superset would mislead core loop into assuming features Haiku lacks.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `capabilities()` returns correct flags per model | matches META-004 §2.2; explicit cache=true, extendedThinking=true for sonnet/opus | 20 | — |
| T2 | `toAnthropicRequest(req)` in `adapter.ts` | all block variants mapped; system as array with cache_control; tools mapped; `cacheHint` → `cache_control` | 60 | T1 |
| T3 | `fromAnthropicStream(events)` in `stream.ts` | yields `CanonicalChunk` for every SDK event; usage captured incl. cache_read/write | 70 | T2 |
| T4 | Error mapping in `errors.ts`: `APIError.status` + `body.error.type` → `ErrorCode.P_*` | 401/403→P_AUTH, 429→P_429, 5xx→P_5XX, network→P_NETWORK, 400 `context_length_exceeded`→P_CONTEXT_OVERFLOW, body.type `overloaded_error`→P_5XX, 404 `not_found_error`→P_MODEL_NOT_FOUND | 30 | — |
| T5 | `countTokens` wrapper | returns number matching SDK response | 20 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/providers/anthropic/adapter.test.ts`:
  - `toAnthropicRequest` maps `cacheHint:'ephemeral'` → `cache_control:{type:'ephemeral'}`
  - Tool use/result round-trip preserves `id`/`toolUseId` ↔ `tool_use_id`
  - System blocks with mixed cacheHint produce array-form `system`
  - >4 `cacheHint` blocks: only last 4 carry `cache_control`, logger.warn called once
- `tests/providers/anthropic/stream.test.ts`:
  - Fixture SDK event stream → expected `CanonicalChunk[]`
  - `usage` chunk includes `cacheRead`/`cacheWrite`
- `tests/providers/anthropic/errors.test.ts`:
  - Each SDK `APIError` status → correct `ErrorCode`
  - `APIError{status:400, body.error.type:'context_length_exceeded'}` → `P_CONTEXT_OVERFLOW`
  - `APIError{status:529, body.error.type:'overloaded_error'}` → `P_5XX`
  - `APIError{status:404, body.error.type:'not_found_error'}` → `P_MODEL_NOT_FOUND`
  - `AbortError` (user cancel) → re-throw, NOT wrap as `P_*`

### 6.2 E2E Tests (gated on `ANTHROPIC_API_KEY`)
- `tests/e2e/providers/anthropic.e2e.ts`:
  - Send "hi" to Haiku → receive `text` chunk + `message_stop` with `end_turn`
  - Send cacheable system prompt twice → second turn `cacheRead > 0`
  - Send tool definition + prompt triggering tool call → receive `tool_use` chunk

### 6.3 Performance Budgets
- Adapter overhead <10ms vs raw SDK call (bench)

### 6.4 Security Checks
- API key read via `process.env.ANTHROPIC_API_KEY` only — never logged, never in error `context`
- `logger.debug` redacts messages content (log length + first 100 chars)

## 7. Interfaces

```ts
// adapter.ts
import Anthropic from '@anthropic-ai/sdk'
import type { Provider, CanonicalRequest, ProviderCapabilities } from '../../ir/types'

export function createAnthropicProvider(opts: {
  apiKey: string
  baseUrl?: string
  defaultModel: string          // REQUIRED — drives capabilities() result
}): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl })
  return {
    id: 'anthropic',
    capabilities: () => anthropicCapabilities(opts.defaultModel),
    stream: (req, { signal }) => streamAnthropic(client, req, signal),
    countTokens: (msgs) => countTokens(client, msgs),
  }
}

// Per-model table: Haiku lacks extendedThinking; all current models are 200k context
export function anthropicCapabilities(model: string): ProviderCapabilities

export function toAnthropicRequest(req: CanonicalRequest): Anthropic.MessageCreateParamsStreaming

// stream.ts
export async function* streamAnthropic(
  client: Anthropic,
  req: CanonicalRequest,
  signal: AbortSignal,
): AsyncIterable<CanonicalChunk>

// cache.ts
export function attachCacheControl(blocks: CanonicalBlock[]): Anthropic.TextBlockParam[]
// Caps at 4 breakpoints, warns on excess

// errors.ts
export function classifyAnthropicError(err: unknown): NimbusError
// Maps: 401→P_AUTH, 403→P_AUTH, 429→P_429, 5xx→P_5XX,
//       fetch-fail→P_NETWORK, 400+"context"→P_CONTEXT_OVERFLOW,
//       404 model→P_MODEL_NOT_FOUND, else→P_INVALID_REQUEST
```

## 8. Files Touched

- `src/providers/anthropic/adapter.ts` (new, ~80 LoC)
- `src/providers/anthropic/stream.ts` (new, ~70 LoC)
- `src/providers/anthropic/cache.ts` (new, ~30 LoC)
- `src/providers/anthropic/errors.ts` (new, ~40 LoC)
- `src/providers/anthropic/index.ts` (new, ~10 LoC re-export)
- `tests/providers/anthropic/*.test.ts` (new, ~250 LoC)

## 9. Open Questions

- [ ] Bedrock/Vertex auth (deferred v0.3)
- [ ] Parallel tool_use ordering stability — verify SDK preserves order

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — per-model capabilities semantic; add `overloaded_error` + `not_found_error` body-type mappings
