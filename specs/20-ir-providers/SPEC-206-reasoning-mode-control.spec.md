---
id: SPEC-206
title: Reasoning mode control (v0.1 subset)
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: ir
depends_on: [SPEC-108, SPEC-202, SPEC-203, SPEC-102]
blocks: []
estimated_loc: 80
files_touched:
  - src/providers/reasoningResolver.ts
  - src/providers/reasoningCue.ts
  - src/channels/cli/slashCommands.ts
  - src/providers/anthropic.ts
  - src/providers/openaiCompat.ts
  - tests/providers/reasoningResolver.test.ts
  - tests/providers/reasoningCue.test.ts
---

# Reasoning Mode Control (v0.1 Subset)

## 1. Outcomes

- User types "think hard about X" (or VN "suy nghĩ kỹ") → agent auto-uses high reasoning effort on a reasoning-capable model; no manual toggle needed
- `/thinking <off|low|medium|high>` slash sets session-scoped override; sticky until `/thinking off` or REPL exit
- Non-reasoning providers (Sonnet, gpt-4o, Groq llama, Ollama) silently drop reasoning params — calls never fail from capability mismatch
- Shipped v0.1.1 at ~80 LoC; full 4-layer design + streaming trace capture deferred to v0.2

## 2. Scope

### 2.1 In-scope (v0.1 subset, 4 components)
- **Resolver** `resolveReasoning({modelId, cueEffort, sessionEffort})` → `{effort, applied}` where `effort ∈ {off, minimal, low, medium, high}`, `applied: boolean` (true if model accepts + params emitted)
- **Reasoning-capability detection**: regex `/^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i` for OpenAI o-series and gpt-5+; curated list `{opus-4-6, sonnet-4-6, sonnet-4-5}` for Anthropic extended-thinking models
- **Cue detector** (bilingual EN+VN) — reuses SPEC-108 `REASONING_CUE_WORDS` + adds low/minimal bucket:
  - `high` effort: `think hard|think deeply|deep think|ultrathink|suy nghĩ kỹ|nghĩ sâu|phân tích kỹ|tư duy sâu`
  - `low`/`minimal` effort: `quick|quickly|nhanh|ngắn gọn|rapid`
  - No cue + reasoning-capable model → default `medium`; otherwise → `off`
- **`/thinking` slash** (SPEC-801 extension) — `on|off|low|medium|high` persists to session meta (`sessions/{id}/meta.json` per SPEC-102)
- **Capability drop** — non-reasoning models: resolver returns `{effort:'off', applied:false}` + `logger.debug({msg:'reasoning dropped', modelId, requested})`; provider adapters receive empty params

### 2.2 Out-of-scope (v0.2+)
- Full 4-layer OpenClaw pattern (inline > session > workspace > global) → v0.2 SPEC-207
- Per-workspace `SOUL.md reasoning:` frontmatter field → v0.2
- Cost-aware auto-downgrade on budget pressure → v0.2 (needs budget modes from SPEC-701 v0.2)
- Streaming reasoning-trace capture (persist thinking blocks to events.jsonl, `/show-thinking` toggle) → v0.2 SPEC-116
- LLM-as-judge auto-selection of effort → v0.3

## 3. Constraints

### Technical
- Resolver pure + sync, <0.2ms p99 (single regex + Map lookup)
- Cue detector reuses SPEC-108 compiled regex; zero extra compile cost
- TS strict; `EffortLevel` narrow union, not `string`
- Dropped params logged at `debug` level only — never `info` (noisy, runs every turn)

### Security
- Cue scanner reads user turns ONLY, NEVER tool output (META-009 T2 indirect injection)
- `/thinking` value whitelisted at parse; malformed → `U_BAD_COMMAND` with friendly error

### Performance
- Zero extra provider round trips — resolver output consumed by existing adapter code path
- No file I/O on hot path beyond SPEC-102 session meta write on `/thinking` change

## 4. Prior Decisions

- **v0.1 subset, not full 4-layer** — task #35 recommended OpenClaw 4-layer (inline>session>workspace>global); v0.1.1 trims to 2 layers (cue, session) at ~80 LoC. Workspace+global defer v0.2 SPEC-207
- **Regex auto-detect over capability registry** — OpenAI o-series + gpt-5+ naming stable; static registry needs update every release. Anthropic set small (3 models) → curated list fine
- **Silent drop over error on non-reasoning models** — users switch providers constantly; throwing breaks `/provider groq` mid-session. Debug log keeps trace, UX smooth
- **Cue vocabulary reuses SPEC-108** — prevents bilingual drift; this spec adds only low/minimal bucket
- **Default `medium` on reasoning models** — matches Claude Code; light reasoning is industry norm (better answer, small cost bump)
- **Session scope for `/thinking`, not workspace** — session = user's current-conversation intent; workspace-wide forces cross-task memory. Workspace default v0.2 when 4-layer ships

## 5. Task Breakdown

| ID | Task | Acceptance | LoC | Depends |
|----|------|------------|----:|---------|
| T1 | `reasoningCue.ts` — low/minimal bucket + detect fn | EN+VN, word-boundary, `null` on no match | 20 | SPEC-108 |
| T2 | `reasoningResolver.ts` — capability detect + resolve | regex + curated list; `{effort, applied}` shape | 25 | T1 |
| T3 | `/thinking` slash + session meta persist | 4 tokens accepted; bad arg → `U_BAD_COMMAND` | 20 | T2, SPEC-801, SPEC-102 |
| T4 | Provider adapter hook-in | Anthropic `thinking.budget_tokens`; OpenAI `reasoning_effort` pass-through; others drop | 15 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `reasoningCue.test.ts`:
  - EN high: `"think hard"`, `"deep think"`, `"ultrathink X"` → `'high'`
  - VN high: `"suy nghĩ kỹ"`, `"phân tích kỹ"`, `"tư duy sâu"` → `'high'`
  - EN/VN low: `"quick answer"`, `"trả lời nhanh"`, `"ngắn gọn thôi"` → `'low'`
  - No cue → `null`; `"rethink"` does NOT match (word boundary)
- `reasoningResolver.test.ts`:
  - `o1-preview`/`o3-mini` → capable; no cue → `{effort:'medium', applied:true}`
  - `gpt-4o` → not capable; any cue → `{effort:'off', applied:false}` + debug log
  - `claude-opus-4-6` capable; `claude-haiku-4-5` not
  - Precedence: session overrides cue; cue overrides model default

### 6.2 E2E Tests
- `tests/e2e/thinking-cue.test.ts`: REPL user msg `"think hard about X"` on `claude-sonnet-4-6` session → assistant reply emitted with `thinking.budget_tokens` in the Anthropic request (mock assert)
- `tests/e2e/thinking-slash.test.ts`: `/thinking high` then next turn → session meta has `reasoningEffort:'high'`; `/thinking off` reverts
- `tests/e2e/thinking-drop.test.ts`: `/provider groq` after `/thinking high` → turn succeeds, no reasoning params in outbound request, debug log contains `reasoning dropped`

### 6.3 Performance / Security
- Resolver <0.2ms p99 across 1K diverse turns (bench)
- Cue scanner fixture: injection payload inside `<tool_output>` NOT triggering cue (META-009 T2)
- `/thinking` parser rejects `xhigh`, `ultra`, empty, SQL-like payloads → `U_BAD_COMMAND`

## 7. Interfaces

```ts
export type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

export interface ResolvedReasoning {
  effort: EffortLevel
  applied: boolean          // false when model can't accept params (silent drop)
}

export function isReasoningCapable(modelId: string): boolean
// OpenAI: /^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i
// Anthropic curated: {opus-4-6, sonnet-4-6, sonnet-4-5}

export function detectReasoningCue(userMessage: string): EffortLevel | null
// Reuses SPEC-108 REASONING_CUE_WORDS (high) + adds low-effort bucket

export function resolveReasoning(input: {
  modelId: string
  cueEffort: EffortLevel | null       // from detectReasoningCue
  sessionEffort: EffortLevel | null   // from session meta (SPEC-102)
}): ResolvedReasoning
// Precedence: session (if set and != null) > cue > model-based default (medium if capable, off otherwise)

// Provider adapter contract (SPEC-202/203)
export function toAnthropicThinking(r: ResolvedReasoning):
  { thinking: { type: 'enabled'; budget_tokens: number } } | {}

export function toOpenAIReasoningEffort(r: ResolvedReasoning):
  { reasoning_effort: 'low' | 'medium' | 'high' } | {}
```

## 8. Files Touched

- `src/providers/reasoningResolver.ts` (~25), `src/providers/reasoningCue.ts` (~20)
- `src/channels/cli/slashCommands.ts` (~20 delta — `/thinking` handler), provider adapter hooks in `src/providers/{anthropic,openaiCompat}.ts` (~15 delta total)
- `tests/providers/reasoningResolver.test.ts` (~120), `tests/providers/reasoningCue.test.ts` (~90)

## 9. Open Questions

- [ ] `/thinking on` → `medium` (ergonomic) or reject (strict)? Lean ergonomic
- [ ] Session end: clear or persist? Lean clear
- [ ] `minimal` vs `low` semantic distinction — defer v0.2 usage data

## 10. Changelog

- 2026-04-15 @hiepht: draft v0.1 subset (regen per #44); cue+resolver+/thinking+drop; SPEC-207 deferred v0.2
