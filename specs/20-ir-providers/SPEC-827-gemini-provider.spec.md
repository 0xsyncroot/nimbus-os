---
id: SPEC-827
title: Gemini provider via OpenAI-compat endpoint
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.2
layer: providers
depends_on: [SPEC-203, SPEC-701, SPEC-902, SPEC-903]
blocks: []
estimated_loc: 80
files_touched:
  - src/providers/endpointCatalog.ts
  - src/cost/priceTable.ts
  - src/onboard/picker.ts
  - src/cli.ts
  - tests/providers/gemini.test.ts
---

# Gemini provider via OpenAI-compat endpoint

## 1. Outcomes

- `nimbus init` picker shows Gemini as option alongside Anthropic/OpenAI/Groq/DeepSeek/Ollama
- `nimbus key set --provider gemini` accepts `AIza*` key, stores in vault, sets workspace `defaultProvider: 'openai-compat'` + model `gemini-2.5-flash`
- Chat request routes to `https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions` with `Authorization: Bearer {GEMINI_API_KEY}`
- Cost tracking accurate for 4 Gemini models

## 2. Scope

### 2.1 In
- Endpoint entry: `gemini` → OpenAI-compat URL
- Price table: `gemini-2.5-pro / 2.5-flash / 2.5-flash-lite / 2.0-flash`
- Key format validation: prefix `AIza`, soft-warn on length ≠ 39
- Wizard picker: option `[4] Gemini (AI Studio free tier, 2.5-flash default)`
- `nimbus key set --provider gemini --base-url ...` accepts optional custom base-url (for Vertex AI future)

### 2.2 Out
- Native Google AI SDK (`@google/generative-ai`) — keep OpenAI-compat only for v0.3.2
- Vertex AI endpoint (enterprise, requires GCP auth flow)
- Context caching via `extra_body.cached_content` (explicit caching) — v0.4
- Thinking mode `thinkingBudget` params — v0.4

## 3. Constraints

### Technical
- No new deps — use existing `openai` SDK (Gemini supports OpenAI-compat beta)
- TS strict; reuse `openai-compat` provider adapter, don't fork
- Key validation: regex `^AIza[A-Za-z0-9_-]{35}$` as soft check; prefix `AIza` hard check

### Cost
- Prices per 2026 Q2 Google AI pricing page (see changelog source URL)
- Cache read rates included; cache write = n/a for OpenAI-compat path (explicit caching deferred)

### Security
- Key stored in vault via existing SPEC-152 AES-GCM path
- Key never logged (use `maskToken` helper)

## 4. Prior Decisions

- **OpenAI-compat endpoint over native SDK** — zero-LoC adapter, Gemini's OpenAI-compat is beta but feature-complete for nimbus agentic (tool calls + streaming confirmed). Native SDK can come in v0.4 if gaps surface.
- **Default model `gemini-2.5-flash`** — best price/performance per Google. Not `2.5-pro` (too expensive for default) or `2.5-flash-lite` (capability too limited for agentic tool use).
- **AI Studio (not Vertex AI)** — AI Studio has simple API key flow + free tier; Vertex AI requires GCP service account + billing setup, out of scope for 1-user nimbus.
- **Key prefix hard check `AIza`** — official Google API key prefix; mismatch almost certainly wrong key.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC |
|----|------|-----------|---------|
| T1 | `endpointCatalog.ts` — add `gemini` entry | `resolveEndpoint('gemini')` returns correct URL | 15 |
| T2 | `priceTable.ts` — add 4 Gemini models | `lookupPrice('gemini-2.5-flash')` returns correct in/out/cacheRead | 20 |
| T3 | Key validation — add `AIza*` regex to provider key validator | unit test positive (AIza...) + negative (sk-..., xoxb-...) | 15 |
| T4 | `onboard/picker.ts` — add Gemini option `[4]` | wizard shows option; selecting routes to key entry | 15 |
| T5 | Tests — endpoint resolve, price lookup, key format, wizard selection | all pass | 15 |

## 6. Verification

### 6.1 Unit
- `endpointCatalog.test.ts`: `resolveEndpoint('gemini')` returns `https://generativelanguage.googleapis.com/v1beta/openai/`
- `priceTable.test.ts`: `gemini/gemini-2.5-flash` has `in: 0.30`, `out: 2.50`, `cacheRead: 0.075`
- `keyValidation.test.ts`: `AIza...(39 chars total)` passes; `sk-...` fails with hint "expected AIza prefix for Gemini"

### 6.2 Smoke (manual, with real key)
- `nimbus init` → pick Gemini → paste AI Studio key → verify vault store → REPL → "hi" → Gemini response streams

## 7. Interfaces

```ts
// endpointCatalog.ts
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/';

// priceTable.ts additions
'gemini/gemini-2.5-pro':        { in: 1.25, out: 10.00, cacheRead: 0.3125, class: 'flagship' },
'gemini/gemini-2.5-flash':      { in: 0.30, out: 2.50,  cacheRead: 0.075,  class: 'balanced' },
'gemini/gemini-2.5-flash-lite': { in: 0.10, out: 0.40,  cacheRead: 0.025,  class: 'budget' },
'gemini/gemini-2.0-flash':      { in: 0.10, out: 0.40,  cacheRead: 0.025,  class: 'fast' },
```

## 8. Files Touched

- `src/providers/endpointCatalog.ts` — +15 LoC
- `src/cost/priceTable.ts` — +20 LoC
- `src/onboard/keyValidation.ts` (or equivalent) — +15 LoC
- `src/onboard/picker.ts` — +15 LoC
- `tests/providers/gemini.test.ts` — new ~30 LoC

## 9. Open Questions

- [ ] Test Gemini tool call round-trip with real API key before v0.3.2 tag — if fails, fallback to native SDK plan
- [ ] `gemini-3-*` pricing (unreleased Q2 2026) — add when GA

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.2 Gemini provider via OpenAI-compat. Docs: https://ai.google.dev/gemini-api/docs/openai. Pricing: https://ai.google.dev/gemini-api/docs/pricing. Key issuance: https://aistudio.google.com/apikey
