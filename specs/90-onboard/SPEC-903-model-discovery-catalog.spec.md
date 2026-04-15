---
id: SPEC-903
title: Model Discovery & Catalog — live fetch + cache + picker UX
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: onboard
depends_on: [SPEC-202, SPEC-203, SPEC-501, SPEC-701, SPEC-901, SPEC-902]
blocks: []
estimated_loc: 180
files_touched:
  - src/catalog/types.ts
  - src/catalog/store.ts
  - src/catalog/classify.ts
  - src/catalog/fetchers/anthropic.ts
  - src/catalog/fetchers/openaiCompat.ts
  - src/catalog/fetchers/ollama.ts
  - src/models/manager.ts
  - src/onboard/init.ts
  - src/cli.ts
  - tests/catalog/types.test.ts
  - tests/catalog/store.test.ts
  - tests/catalog/fetchers.test.ts
  - tests/catalog/picker.test.ts
---

# Model Discovery & Catalog

## 1. Outcomes

- Wizard step after key: fetch model list 2-5s + filtered picker (↑↓ select, Enter confirm, `c` custom, `s` skip)
- Cached at `~/.nimbus/catalog/{provider}-{endpointHash}.json`, TTL 7d; re-runs reuse silently
- Offline/fail → curated `priceTable.ts` fallback + `[MODELS] using curated list, may be stale` banner
- v0.2 unlocks `nimbus models list|refresh` CLI via same catalog store
- Industry differentiator: Claude Code / Aider / Cline don't ship live fetch+picker in wizard

## 2. Scope

### 2.1 IN v0.1 CORE (~120 LoC)
- 3 fetchers: `anthropic` (`GET /v1/models`), `openaiCompat` universal (`GET {baseUrl}/v1/models`), `ollama` (`GET {baseUrl}/api/tags`)
- File cache `~/.nimbus/catalog/{provider}-{sha256(endpoint).slice(0,8)}.json` TTL 7d
- Filters: Anthropic `capabilities.chat===true`; OpenAI-compat regex `/^(gpt-[45]|o[1-9]|claude|llama|deepseek|mixtral|qwen)/i`; Ollama include all tags
- Wizard picker replaces free-text model field in SPEC-901 step 9
- Class hint via fuzzy match against SPEC-701 `priceTable.ts`
- Graceful degrade on offline/timeout/4xx/5xx → curated fallback

### 2.2 IN v0.1 extended, OUT core (~60 LoC deferred)
- `nimbus models list|refresh` CLI (T8)
- Advanced class inference beyond priceTable fuzzy (T6)
- Cache invalidation heuristics (T9 — age-based + new-endpoint detection)

### 2.3 OUT v0.1 (v0.2+)
- Live pricing sync (pull prices from provider API when supported)
- Capability matrix (vision / tool-use / thinking booleans per model)
- Model benchmarks + recommendations

## 3. Constraints

### Technical
- 5s fetch timeout; override via `catalog.fetchTimeoutMs`
- Non-blocking: `s` (skip) + `c` (custom) always available even pre-fetch
- Cache file 0644 (public metadata); key separate via SPEC-152
- HTTPS only except Ollama loopback (`127.0.0.1`/`localhost`)
- Max 200 entries; over → truncate + warn

### Security
- Key never logged/cached; only endpointHash (first 8 of sha256) in filename
- Response 500KB hard cap pre-parse
- HTTPS bypass only when host resolves to loopback

## 4. Prior Decisions

- **Option E over Option D** — CLI deferred v0.2; fetch+picker alone delivers the user win
- **File JSON cache, not SQLite** — infrequent reads, ≤200 entries; SQLite dep not worth it
- **OpenAI client-side regex allowlist** — API lacks chat-capable flag; server filter is wrong layer
- **priceTable.ts as fallback** — existing 9-ID list; reuse prevents drift
- **Depends SPEC-902 key first** — fetchers (except Ollama) need resolved key; step 8 key → step 9 picker
- **Custom endpoint via SPEC-902 baseUrl** — same config + auth path as chat calls
- **Wizard non-blocking** — network fail NEVER blocks; curated fallback keeps offline install viable
- **Cache keyed `{provider}-{endpointHash}`** — work Azure + personal OpenAI stay separate

## 5. Task Breakdown

> v0.1 CORE = T1-T5, T7 (~120 LoC shipped). Extended T6/T8/T9 (~60 LoC) deferred to v0.2.

| ID | Task | LoC | Depends |
|----|------|----:|---------|
| T1 | `types.ts` — `ModelDescriptor` + Zod schema | 20 | — |
| T2 | `fetchers/anthropic.ts` — /v1/models + filter | 30 | T1 |
| T3 | `fetchers/openaiCompat.ts` — /v1/models + regex allowlist | 40 | T1 |
| T4 | `fetchers/ollama.ts` — /api/tags parse | 15 | T1 |
| T5 | `store.ts` — file cache TTL 7d + priceTable fallback | 25 | T1 |
| T7 | Wizard picker (readline select + `c`/`s` keys) | 30 | T2, T3, T4, T5, SPEC-901 |

**Deferred (v0.2, shown for context)**:
| T6 | Advanced class inference heuristics | 20 |
| T8 | `nimbus models list\|refresh` CLI | 30 |
| T9 | Cache invalidation heuristics | 10 |

## 6. Verification

### 6.1 Unit Tests
- `fetchers.test.ts`:
  - Anthropic: parse response + filter `capabilities.chat` true/false; 401 → `auth`; timeout → `timeout`
  - OpenAI-compat regex allowlist: `gpt-4o`✅, `text-embedding-3-small`❌, `dall-e-3`❌, `whisper-1`❌, `claude-sonnet-4-6`✅, `llama-3.3-70b`✅
  - Ollama `/api/tags` parse; empty → `{ok:true, models:[]}`; malformed → `parse`
- `store.test.ts`: write+read round-trip; TTL 7d expire (mock time); force-refresh bypasses cache; corrupt cache → miss; mode 0644 asserted
- `types.test.ts`: Zod rejects missing `id`/`provider`; accepts optional fields
- `picker.test.ts`: ↑↓ move cursor; Enter returns selected id; `c` prompts free text; `s` returns `null`; list >25 paginates; offline fallback banner shown

### 6.2 E2E Tests
- `init --no-prompt --provider anthropic` with mocked fetch → picker shows live list; workspace.json records selected model
- Mock fetch timeout → fallback to curated + `[MODELS] using curated list, may be stale` banner
- Full wizard: provider → key → baseUrl → models picker → workspace saved with chosen id

### 6.3 Security
- HTTPS-only asserted: non-loopback `http://...` rejected; `http://localhost:11434` accepted for Ollama only
- No API key in fetched/cached payload (grep cache dir for key prefixes → 0 matches)
- Raw API response NEVER written to logs; only normalized `ModelDescriptor[]` reaches store

## 7. Interfaces

```ts
export interface ModelDescriptor {
  id: string
  provider: string
  displayName?: string
  contextLength?: number
  classHint?: 'flagship'|'workhorse'|'budget'|'reasoning'|'local'
  priceHint?: { in: number; out: number } | 'unknown'
  source: 'live' | 'cache' | 'curated'
  fetchedAt?: number
}

export interface ProviderCatalogFetcher {
  fetch(baseUrl: string, apiKey: string, opts: { timeoutMs: number }): Promise<ModelDescriptor[]>
  filter(raw: unknown[]): ModelDescriptor[]
}

export interface ModelCatalog {
  list(provider: string, opts?: { refresh?: boolean }): Promise<ModelDescriptor[]>
  get(provider: string, modelId: string): Promise<ModelDescriptor | null>
  refresh(provider: string): Promise<ModelDescriptor[]>
  invalidate(provider: string): Promise<void>
}
```

## 8. Files Touched

**v0.1 core** (~120 LoC): `src/catalog/{types,store,classify}.ts`, `src/catalog/fetchers/{anthropic,openaiCompat,ollama}.ts`, `src/onboard/init.ts` (modify — step 9 picker); tests `tests/catalog/{types,store,fetchers,picker}.test.ts` (~300 LoC)

**v0.2 extended** (~60 LoC): `src/models/manager.ts`, `src/cli.ts` (route `nimbus models`)

## 9. Open Questions

- [ ] Key rotation on same endpoint — invalidate catalog? (lean no — models are endpoint-scoped)
- [ ] Multiple Ollama (localhost + Tailscale) — separate catalog each? (endpointHash handles it)
- [ ] Curated fallback: all priceTable or provider-scoped? (lean provider-scoped)

## 10. Changelog

- 2026-04-15 @hiepht: draft Option E; v0.1 core T1-T5+T7 (~120 LoC); T6/T8/T9 deferred v0.2
