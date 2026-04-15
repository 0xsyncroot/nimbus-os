---
id: SPEC-203
title: OpenAI-compat provider adapter
status: implemented
version: 0.1.2
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: providers
depends_on: [SPEC-201, META-003, META-004]
blocks: [SPEC-103]
estimated_loc: 200
files_touched:
  - src/providers/openaiCompat.ts
  - src/providers/registry.ts
  - tests/providers/openaiCompat.test.ts
  - tests/providers/openaiCompatStream.test.ts
  - tests/providers/openaiCompatReasoning.test.ts
---

# OpenAI-Compatible Provider Adapter

## 1. Outcomes

- One adapter serves OpenAI, Groq, DeepSeek, Ollama, any `/v1/chat/completions`-compatible endpoint via `baseUrl` config
- Streaming `tool_calls` with `function.name` + incremental `function.arguments` deltas reassembled into IR `tool_use` blocks
- Thinking blocks from IR silently stripped when sent (OpenAI/o1 don't support), user-visible text preserved
- Implicit prefix cache reported via `usage.prompt_tokens_details.cached_tokens` → `CanonicalChunk.usage.cacheRead`

## 2. Scope

### 2.1 In-scope
- Implement `Provider` (SPEC-201) on top of `openai` SDK `chat.completions.create({stream:true})`
- `baseUrl` config drives endpoint (Groq=`https://api.groq.com/openai/v1`, DeepSeek=`https://api.deepseek.com/v1`, Ollama=`http://localhost:11434/v1`)
- CanonicalMessage → OpenAI message array: split `tool_result` into separate `role:'tool'` messages (OpenAI shape)
- OpenAI `tool_calls[].function.name`+`.arguments` → IR `tool_use{id,name,input:JSON.parse(args)}`
- Streaming delta accumulator: piece together `tool_calls` from partial deltas keyed by `index`
- **Args JSON parse is deferred** to `finish_reason`/stream-end. Per-delta parse is forbidden — SSE splits JSON at arbitrary byte boundaries (`{"pa`, `th":"`, `README.md"}`), so partial fragments are expected to be invalid JSON and MUST NOT surface as errors.
- Capabilities per endpoint: `promptCaching: 'implicit'` for OpenAI/DeepSeek, `'none'` for Groq/Ollama

### 2.2 Out-of-scope (defer to other specs)
- Anthropic-specific behaviors → SPEC-202
- o1-series reasoning_tokens cost mapping → v0.2 cost optimizer
- Azure OpenAI auth (API-key + deployment) → v0.3 if needed
- Tool-use fallback prompt for endpoints without native tools → v0.2

## 3. Constraints

### Technical
- Layer: `src/providers/openaiCompat/` imports ONLY `src/ir/`, `openai`, `zod`. NO `core/`, `tools/`, `platform/`.
- Bun-compatible (`openai` SDK uses fetch)
- TypeScript strict, no `any`; `function.arguments` parsing is `unknown` → guarded JSON.parse
- Max 400 LoC per file — split by concern
- **Reasoning-model param switch**: when model name matches `/^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i`, send `max_completion_tokens` instead of `max_tokens` and DROP `temperature` (OpenAI reasoning models reject both). Detection is pattern-based because OpenAI currently exposes no machine-readable capability flag. Bypass via baseUrl proxy that renames a non-reasoning model to `o1-*` is explicitly unsupported.

### Performance
- Adapter overhead <10ms vs raw SDK
- `tool_calls` delta accumulator O(n) in chunks

## 4. Prior Decisions

- **Single adapter, endpoint registry** — not one adapter per provider. `endpoints.ts` maps `'groq'|'deepseek'|'ollama'|'openai'` → `{baseUrl, capabilities}`. Adding a provider = one entry.
- **Split tool_result into separate `role:'tool'` messages** — OpenAI requires this shape even though IR keeps them inside user turn. Lossless bidirectional (adapter reverses on incoming, but incoming from OpenAI never has tool_result — LLM emits tool_call only).
- **Strip `thinking` blocks silently** — per META-004 §2.4 normalization table. Log once per session on first strip to aid debugging.
- **`JSON.parse(function.arguments)` inside `try`** — invalid JSON → emit `tool_use` with `input: null` + chunk `error` to downstream; do NOT throw (would abort stream).
- **tool_call args MUST NOT parse per-delta** — accumulate `args` across all deltas keyed by `tool_calls[i].index`, parse exactly once when `finish_reason` arrives (or at stream end as fallback). Rationale: OpenAI/Groq/DeepSeek/vLLM split JSON at arbitrary byte boundaries, so any single delta may be syntactically invalid (`{"pa`). Per-delta parsing triggered spurious `P_INVALID_REQUEST` error chunks that propagated up through the core loop and broke every tool call (HIGH bug found by QA in v0.1.0-alpha, task #30). Fix: defer parse; emit `content_block_start` with the fully-parsed `input` once, immediately followed by `content_block_stop`.
- **`countTokens` accuracy bound documented** — tiktoken for `openai` endpoint is accurate (±1%). `chars/4` fallback for Groq/DeepSeek/Ollama is approximate (±25% typical, up to ±40% for code-heavy content). Consumers (SPEC-701 cost estimator) MUST treat fallback as lower-bound only.
- **`getEndpoint` throws on unknown** — signature `getEndpoint(name: EndpointName): EndpointConfig` uses union type; `getEndpointDynamic(name: string)` variant exists for config-driven lookup and throws `NimbusError(U_MISSING_CONFIG)` on miss.
- **Reasoning-model detection by regex, not capability flag** (task #32) — OpenAI reasoning models (`o1`, `o1-mini`, `o3-*`, `o4-*`, `gpt-5*`, `gpt-6+`) require `max_completion_tokens` and reject `temperature`. Considered adding `ProviderCapabilities.usesCompletionTokens` but this varies per-model, not per-endpoint, so endpoint-level capabilities are the wrong granularity. Considered dispatching on `defaultModel` at `createOpenAICompatProvider` time but model can change per-request once SPEC-106 model router lands. Chose: pure function `isReasoningModel(model: string): boolean` on the request path, matching `/^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i`. Anchored prefix avoids false-match on user-chosen names like `custom-o1-mimic`. DeepSeek/Groq/Ollama don't publish reasoning models under OpenAI names, so the regex stays narrow.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `endpoints.ts`: registry per provider id with baseUrl + capabilities | `getEndpoint('groq')` returns correct `baseUrl` + `supportsParallelTools:true, promptCaching:'none'` | 30 | — |
| T2 | `toOpenAIMessages(msgs)` in `adapter.ts` | flattens blocks; splits `tool_result` into `role:'tool'`; strips `thinking`; images → `image_url` | 60 | T1 |
| T3 | `fromOpenAIStream(events)` in `stream.ts` — accumulates `tool_calls` deltas by index, emits chunks | fixture replay → expected `CanonicalChunk[]`; usage.cached_tokens → `cacheRead` | 70 | T2 |
| T-fix | Defer `JSON.parse(acc.args)` until `finish_reason` | partial-JSON deltas `{"pa`,`th":"`,`v"}` produce zero error chunks; single `content_block_start{tool_use, input:{path:'v'}}` emitted at finish | 10 | T3 |
| T-reason | Reasoning-model param switch (`isReasoningModel`) | `o1-mini`/`gpt-5-mini` → `max_completion_tokens` set, `max_tokens`+`temperature` omitted; `gpt-4o-mini` unchanged | 15 | T3 |
| T4 | Error mapping in `errors.ts` | 401→P_AUTH, 429→P_429, 5xx→P_5XX, network→P_NETWORK, context→P_CONTEXT_OVERFLOW, unknown-model→P_MODEL_NOT_FOUND | 30 | — |
| T5 | `countTokens` fallback (tiktoken for openai, chars/4 for others) | openai within ±1% of API response; non-openai logs `{approximate:true, boundPct:25}` | 10 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/providers/openaiCompat/adapter.test.ts`:
  - Message with `tool_result` block → two OpenAI messages: one `assistant` (if preceded tool_use) + one `tool`
  - `thinking` block stripped, `logger.debug` called with `provider=openai-compat strip=thinking`
  - `image` block with `kind:'base64'` → `image_url: data:${mime};base64,${data}`
  - `cacheHint` dropped (OpenAI has no explicit cache_control)
- `tests/providers/openaiCompatStream.test.ts`:
  - Fixture: 3 deltas for same `tool_calls[0]` → single assembled `tool_use` chunk with full arguments JSON
  - **QA repro (task #30)**: char-by-char fragments `{"pa` / `th":"` / `READ` / `ME.md"}` produce **zero `error` chunks** during accumulation and one `content_block_start{tool_use, input:{path:'README.md'}}` on finish
  - Split tool name across deltas (`ba` + `sh` → `"bash"`)
  - Parallel tool_calls at different `index` both emitted
  - Empty `args` string → `input: {}` (tools with no parameters)
  - Malformed JSON at finish: `error` chunk emitted once, `message_stop` still yielded, no `content_block_start` for the broken call
  - Text-only response: no tool_use block, no JSON parse attempted
  - `usage.prompt_tokens_details.cached_tokens` → `usage.cacheRead`
- `tests/providers/openaiCompat/endpoints.test.ts`:
  - Each registered provider has valid URL + capabilities matching plan §12 table
- `tests/providers/openaiCompatReasoning.test.ts`:
  - `isReasoningModel` matches `o1`, `o1-mini`, `o3-mini`, `o4-mini`, `gpt-5`, `gpt-5-mini`, `gpt-5.4-mini`, `gpt-6`
  - `isReasoningModel` rejects `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`, `llama-3.3-70b`, `deepseek-chat`, `gemma-2-9b`
  - Case-insensitive (`O1-MINI`, `GPT-5`)
  - No false-match on substrings (`custom-o1-mimic`, `myorg/gpt-5-clone`)
  - Reasoning model request → `params.max_completion_tokens` set, `max_tokens`+`temperature` absent
  - Non-reasoning model request → `params.max_tokens` + `temperature` set, `max_completion_tokens` absent

### 6.2 E2E Tests (gated on env flags)
- `tests/e2e/providers/groq.e2e.ts` (requires `GROQ_API_KEY`): send "hi" to `llama-3.3-70b`, receive text chunk
- `tests/e2e/providers/ollama.e2e.ts` (skips if no local Ollama): verify localhost endpoint works

### 6.4 Security Checks
- API key read via `process.env.{PROVIDER}_API_KEY`, never logged
- `baseUrl` validated via Zod URL schema (reject `file://`, `chrome://`)
- Request body never logged at info level

## 7. Interfaces

```ts
// endpoints.ts
export interface EndpointConfig {
  id: string                              // 'openai-compat:groq'
  baseUrl: string
  capabilities: ProviderCapabilities
  apiKeyEnv: string                       // 'GROQ_API_KEY'
}
export type EndpointName = 'openai' | 'groq' | 'deepseek' | 'ollama'
export const ENDPOINTS: Record<EndpointName, EndpointConfig>
export function getEndpoint(name: EndpointName): EndpointConfig             // compile-checked
export function getEndpointDynamic(name: string): EndpointConfig            // throws NimbusError(U_MISSING_CONFIG) on miss

// adapter.ts
import OpenAI from 'openai'
export function createOpenAICompatProvider(opts: {
  endpoint: keyof typeof ENDPOINTS | 'custom'
  baseUrl?: string
  apiKey?: string
  defaultModel?: string
}): Provider

export function toOpenAIMessages(msgs: CanonicalMessage[]): OpenAI.ChatCompletionMessageParam[]

// stream.ts — accumulator preserves delta ordering
export async function* streamOpenAICompat(
  client: OpenAI,
  req: CanonicalRequest,
  signal: AbortSignal,
): AsyncIterable<CanonicalChunk>

// errors.ts
export function classifyOpenAIError(err: unknown): NimbusError

// reasoning model detection — regex on model name, exported for core/router use
export function isReasoningModel(model: string): boolean
```

## 8. Files Touched

- `src/providers/openaiCompat/adapter.ts` (new, ~80 LoC)
- `src/providers/openaiCompat/stream.ts` (new, ~80 LoC)
- `src/providers/openaiCompat/endpoints.ts` (new, ~40 LoC)
- `src/providers/openaiCompat/errors.ts` (new, ~30 LoC)
- `src/providers/openaiCompat/index.ts` (new, ~10 LoC)
- `tests/providers/openaiCompat/*.test.ts` (new, ~280 LoC)

## 9. Open Questions

- [ ] Should endpoint registry be config-file override (`~/.nimbus/endpoints.json`) in v0.1 or defer?
- [ ] Azure OpenAI deployment-id routing (deferred v0.3)
- [ ] DeepSeek E2E fixture — defer to v0.2 unless user requests sooner
- [ ] Verify DeepSeek R1 (`deepseek-reasoner` / `deepseek-r1`) param requirements on live endpoint. Public docs use `max_tokens`, so current regex excludes it. If QA observes HTTP 400 on live call → one-line extension: `/^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$)|deepseek-r)/i` + reasoning-test case. Do NOT extend without confirmed 400 (would break currently-working R1 requests).

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — `EndpointName` union + dynamic lookup separated; `countTokens` accuracy bound documented
- 2026-04-15 @hiepht: v0.1.1 HIGH-bug fix (task #30) — defer JSON parse of `tool_calls[].function.arguments` until `finish_reason`. Per-delta parsing surfaced partial-JSON fragments as spurious `P_INVALID_REQUEST` errors; core loop throws on provider error chunks, so every OpenAI-compat tool call broke in v0.1.0-alpha. Added task T-fix, 7 unit tests in `openaiCompatStream.test.ts` (including QA reproducer).
- 2026-04-15 @hiepht: v0.1.2 HIGH-bug fix (task #32) — reasoning-model param switch. `o1-*`/`o3-*`/`o4-*`/`gpt-5+` require `max_completion_tokens` + reject `temperature` (HTTP 400 on default request). Added `isReasoningModel(model)` pure function + request-time switch. New task T-reason, 9 unit tests in `openaiCompatReasoning.test.ts`.
