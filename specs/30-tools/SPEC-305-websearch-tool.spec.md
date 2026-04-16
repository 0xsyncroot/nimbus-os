---
id: SPEC-305
title: WebSearch tool — Tavily default, multi-backend
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
implemented: 2026-04-16
release: v0.2
layer: tools
depends_on: [SPEC-301, SPEC-152, META-003, META-009]
blocks: []
estimated_loc: 200
files_touched:
  - src/tools/builtin/WebSearch.ts
  - src/tools/builtin/webSearch/types.ts
  - src/tools/builtin/webSearch/sanitize.ts
  - src/tools/builtin/webSearch/cache.ts
  - src/tools/builtin/webSearch/tavily.ts
  - src/tools/builtin/webSearch/brave.ts
  - src/tools/builtin/webSearch/exa.ts
  - tests/tools/builtin/webSearch.test.ts
---

# WebSearch tool — Tavily default, Brave opt-in, Exa advanced

## 1. Outcomes

- Agent (and `/search` slash) can perform live web search via a single canonical tool
- Three backends: Tavily (default, 1K free/mo), Brave (opt-in, independent index), Exa (semantic/advanced)
- BYOK per provider via existing vault (SPEC-152); zero-config path with Tavily free tier
- Search results safe-by-default against HTML/JS injection in snippets

## 2. Scope

### 2.1 In-scope

- Zod input `{query: string 1..500, maxResults?: 1..20 default 5, dateRange?: 'day'|'week'|'month'|'year'}`
- Zod output `{results: Array<{title, url, snippet, publishedDate?}>, provider, query}`
- Three fetchers with bounded-fetch helper (timeout 5s, 500KB byte cap, error classification)
- HTML tag strip on snippets (shallow parser removes `<script>`, `<style>`, all tags)
- Injection detector pass on plain-text snippets (catches `Ignore previous instructions` patterns — prompt injection defense beyond HTML strip, cross-ref META-009 T2)
- URL validation: require HTTPS, reject non-public IPs; route through `ssrfGuard` module (META-009 L4 DNS rebind protection)
- Fetcher error payloads must strip Authorization headers before caching/logging (prevent API key leak via error body)
- Per-workspace result cache: key=sha256(provider+query+params), TTL 1h, on-disk JSON, MAX_CACHE_ENTRIES=500 with LRU eviction (10MB cap)
- CostEvent emission per search query: `{kind:'web_search', provider, estimatedCost}` integrated with SPEC-701 cost tracking
- Fallback chain: on primary provider fail → secondary if configured → error message

### 2.2 Out-of-scope

- SerpAPI — Google v SerpAPI litigation Dec 2025, active legal risk
- DuckDuckGo — no stable TS API; HTML scraping fragile
- Perplexity Sonar — returns synthesized answer not result list (wrong shape for agent to decide)
- Kagi — $25/1K + beta/no SLA
- Auto-fetching result page content (that's WebFetch, separate tool)

## 3. Constraints

### Technical
- Bun-native fetch, TypeScript strict, max 400 LoC per file, no `any`
- HTTPS-only URLs in snippet output
- Byte cap 500KB per search response
- Respect provider rate limits via retry-after header

### Performance
- Search latency <2s p95 (network-bound, not controllable beyond timeout)
- Cache lookup <5ms

## 4. Prior Decisions

- **Tavily default** — official `@tavily/core` TS SDK, 1K free/mo, $3/1K paid, designed for LLM grounding, no legal risk
- **Brave opt-in** — independent index, best latency (~669ms), $5/1K, raw HTTP simple
- **Exa advanced** — semantic neural search, $7/1K, concept-level queries, official `exa-js`
- **SerpAPI excluded** — Dec 2025 Google lawsuit (DMCA), hearing May 2026
- **DDG excluded** — no stable TS API; HTML scraping fragile and ToS-violating
- **Perplexity excluded** — returns synthesized answer, agent needs URL list to decide
- **Kagi excluded** — $25/1K + beta/no SLA, 5-10x more expensive
- **HTML strip on snippets** — search results are untrusted text; wrap in `<tool_output trusted="false">` per META-009

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Zod input/output schemas + types | schema round-trip tests pass | 30 | — |
| T2 | Tavily fetcher via @tavily/core SDK | 200 + 401 + timeout + malformed mock tests | 40 | T1 |
| T3 | Brave fetcher via raw HTTP | same 4 mock scenarios | 35 | T1 |
| T4 | Exa fetcher via exa-js SDK | same 4 mock scenarios | 35 | T1 |
| T5 | HTML strip + URL validator | 10-case fixture tests | 25 | — |
| T6 | Cache layer (file-backed, TTL 1h) | hit/miss/expire tests | 20 | — |
| T7 | Fallback chain + tool registration | primary fail → secondary test | 15 | T2,T3 |

## 6. Verification

### 6.1 Unit Tests
- Per-fetcher HTTP mock (200/401/timeout/malformed)
- Schema round-trip, HTML strip fixtures, URL validation
- Cache TTL hit/miss/expire

### 6.2 E2E Tests
- Mocked provider end-to-end via stub HTTP server

### 6.3 Security Checks
- Leak guard: grep cache dir for API key prefixes → 0 matches
- HTML `<script>` in snippet → stripped
- Non-HTTPS URL in result → rejected

## 7. Interfaces

```ts
const WebSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(20).optional().default(5),
  dateRange: z.enum(['day', 'week', 'month', 'year']).optional(),
});

const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  publishedDate: z.string().optional(),
});

const WebSearchOutputSchema = z.object({
  results: z.array(WebSearchResultSchema),
  provider: z.string(),
  query: z.string(),
});
```

## 8. Files Touched

- `src/tools/builtin/WebSearch.ts` (new, ~60 LoC)
- `src/tools/builtin/webSearchFetchers/tavily.ts` (new, ~40 LoC)
- `src/tools/builtin/webSearchFetchers/brave.ts` (new, ~35 LoC)
- `src/tools/builtin/webSearchFetchers/exa.ts` (new, ~35 LoC)
- `tests/tools/builtin/webSearch.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Should WebSearch auto-trigger when agent detects "I need to look this up"? (v0.2 skill?)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on WebSearch API landscape research (Tavily/Brave/Exa comparison)
- 2026-04-16 @developer-tools: implemented — raw HTTP fetchers (no SDK deps needed), file-backed LRU cache, HTML strip + injection detector, URL validator, fallback chain, cost event emission, 46 unit tests
