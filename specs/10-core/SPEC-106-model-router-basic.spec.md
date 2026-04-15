---
id: SPEC-106
title: Model router basic — class to provider+model
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-004, SPEC-201, SPEC-501]
blocks: [SPEC-103]
estimated_loc: 80
files_touched:
  - src/core/modelRouter.ts
  - src/core/modelClasses.ts
  - tests/core/modelRouter.test.ts
---

# Model Router (Basic, Config-Based)

## 1. Outcomes

- Caller requests by model **class** (`flagship` | `workhorse` | `budget` | `reasoning` | `local`) not by raw model ID — provider/model lookup happens once, in router.
- Config (`SPEC-501`) defines the `class → (provider, model)` table; switching to cheaper backend requires editing 1 line, not touching call sites.
- `routeModel(class)` returns `{providerId, modelId}` in <0.1ms (pure lookup); unknown class throws `NimbusError(S_CONFIG_INVALID)`.
- `/provider` and `/model` REPL commands mutate router state at runtime (in-memory override; persisted on restart via config).

## 2. Scope

### 2.1 In-scope
- `ModelClass` string enum + routing table schema.
- `routeModel(cls, ctx?)` function + runtime override via `setOverride(cls, {provider, model})`.
- Load table from config on start; validate each entry (provider exists in registry — see SPEC-202/203).
- Default table for first-time users (Anthropic flagship=opus-4-6, workhorse=sonnet-4-6, haiku-4-5 budget; OpenAI workhorse=gpt-4o; Groq budget=llama-3.3-70b).

### 2.2 Out-of-scope
- Cost-aware routing (pick cheapest model meeting latency SLA) → v0.4 optimizer.
- Fallback on provider failure → v0.2 (self-heal engine wires into router).
- Task-based routing (reasoning class for plan phase) → v0.2.
- Multi-model per turn → v0.3.

## 3. Constraints

### Technical
- Pure sync lookup function (no I/O in hot path).
- Config schema validated at load via Zod; malformed → `S_CONFIG_INVALID`.
- TS strict; `ModelClass` narrowed to specific union, not `string`.

### Performance
- `routeModel()` <0.1ms (single `Map.get`).
- Config reload <10ms (rare, `/reload-config`).

### Resource
- Table size bounded: ≤ 50 entries (reject larger — indicates config corruption).

## 4. Prior Decisions

- **Class-based routing, not per-task** — why: v0.1 needs one stable knob; cost-aware/task-based adds complexity without clear user demand for MVP.
- **Config-driven, not hardcoded** — why: users switch providers (e.g., move from Anthropic trial to Groq free) without rebuilding; meets "offline first + multi-provider from day 1" (plan §1).
- **In-memory override + persist separately** — why: `/model` switch during REPL shouldn't write disk every keypress; persist only on explicit `nimbus config save` or exit.
- **5 classes (flagship/workhorse/budget/reasoning/local)** — why: matches price table buckets in plan §12. Adding a 6th requires cost table update in sync.
- **Throw on unknown class** — why not silent default: hides bugs where caller typos class name; explicit is cheap at this layer.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `modelClasses.ts`: union + default table | 5 classes enumerated; default table valid | 20 | — |
| T2 | `modelRouter.ts`: `routeModel(cls)` + override | lookup <0.1ms; unknown class throws `S_CONFIG_INVALID` | 40 | T1 |
| T3 | Config loader integration via SPEC-501 | reads `modelRouting` field; validates providers exist | 20 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/modelRouter.test.ts`:
  - `describe('SPEC-106: modelRouter')`:
    - Default table: `routeModel('flagship')` → `{providerId: 'anthropic', modelId: 'claude-opus-4-6'}`.
    - `routeModel('budget')` → matches table entry.
    - `routeModel('nonexistent' as ModelClass)` → throws `NimbusError(S_CONFIG_INVALID)`.
    - `setOverride('workhorse', {providerId: 'groq', modelId: 'llama-3.3-70b'})` → subsequent `routeModel('workhorse')` reflects override.
    - Config with unknown provider → throws at load: `NimbusError(S_CONFIG_INVALID, {provider})`.

### 6.2 E2E Tests
- REPL `/model budget` → next turn uses budget-class model (assert via cost event provider/model in SPEC-701 test).

### 6.3 Performance Budgets
- `routeModel()` <0.1ms via `bun:test` bench (1000 iters).

### 6.4 Security Checks
- Table cannot reference provider not in registry (prevents arbitrary ID → HTTP call to evil host): validated at load time.
- Override doesn't persist across process restart unless explicitly saved.

## 7. Interfaces

```ts
// modelClasses.ts
export type ModelClass = 'flagship' | 'workhorse' | 'budget' | 'reasoning' | 'local'

export const ModelRoutingSchema = z.record(
  z.enum(['flagship', 'workhorse', 'budget', 'reasoning', 'local']),
  z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  })
)
export type ModelRouting = z.infer<typeof ModelRoutingSchema>

export const DEFAULT_ROUTING: ModelRouting = {
  flagship:  { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
  workhorse: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
  budget:    { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  // reasoning aliases flagship in v0.1 (both use Opus thinking-capable).
  // User with OpenAI/DeepSeek access should override config → o1 / deepseek-r1.
  // Distinct default deferred to v0.2 once fallback-provider logic exists.
  reasoning: { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
  local:     { providerId: 'ollama',    modelId: 'llama3' },
}

// modelRouter.ts
export interface ResolvedModel {
  providerId: string
  modelId: string
}

export function routeModel(cls: ModelClass): ResolvedModel
export function setOverride(cls: ModelClass, resolved: ResolvedModel): void
export function clearOverride(cls: ModelClass): void
export function loadRoutingFromConfig(routing: ModelRouting): void  // called at startup
export function currentRouting(): ModelRouting                      // for diag/observability

// One-turn class promotion — caller uses return value for the next request,
// then reverts to prior class on subsequent turns. Pure (does NOT mutate
// router state). Used by agentLoop when SPEC-108 detects
// `promoteToReasoning: true` in user input OR user runs /think slash.
// v0.1: target 'reasoning' only; future targets (flagship, etc.) v0.2.
export function promoteClass(currentClass: ModelClass, target: 'reasoning'): ModelClass
```

## 8. Files Touched

- `src/core/modelRouter.ts` (new, ~50 LoC)
- `src/core/modelClasses.ts` (new, ~30 LoC)
- `tests/core/modelRouter.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should `/model <id>` (raw) also bypass router, or always go through class? v0.1: class-only; raw bypass v0.2 if users ask.
- [ ] v0.2 full reasoning resolution 4-layer (SPEC-207 planned) — inline cue > session > workspace > global with provider-specific param mapping (Anthropic `budget_tokens`, OpenAI `reasoning_effort`). v0.1 ships simpler `promoteClass` + cue-detect instead.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
- 2026-04-15 @hiepht: add `promoteClass(current, 'reasoning')` for one-turn upgrade triggered by SPEC-108 cue detect or `/think` slash; pure (no state mutation); caller reverts after turn
