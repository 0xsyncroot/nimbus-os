---
id: SPEC-702
title: Cost estimator + budget enforcement modes
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.2
layer: cost
depends_on: [SPEC-701, SPEC-201]
blocks: []
estimated_loc: 200
files_touched:
  - src/cost/estimator.ts
  - src/cost/budget.ts
  - tests/cost/estimator.test.ts
  - tests/cost/budget.test.ts
---

# Cost Estimator + Budget Enforcement

## 1. Outcomes

- Agent estimates token cost before executing a turn so users are never surprised by expensive calls
- Four enforcement modes let users choose how aggressively to gate spending (`warn`, `soft-stop`, `hard-stop`, `fallback`)
- `/budget $X` slash command lets users set daily budget without editing config manually
- `fallback` mode auto-downgrades model class so work continues within budget rather than hard-blocking

## 2. Scope

### 2.1 In-scope

- Token counter: Anthropic SDK `countTokens` for Anthropic; `tiktoken` for OpenAI; `chars/4` heuristic for local/unknown
- Estimate hi/lo band from P25/P90 of last 20 `CostEvent` records for that (provider, model) pair
- Warn threshold: `costHi > $0.20` OR estimated turn cost exceeds remaining daily budget
- Budget config in `workspace.json`: `{dailyBudget: number, mode: 'warn'|'soft-stop'|'hard-stop'|'fallback'}`
- `warn` — print cost banner, proceed
- `soft-stop` — ask user Y/N before proceeding
- `hard-stop` — refuse turn, return error message
- `fallback` — auto-downgrade model class (flagship→workhorse→budget) and retry estimate; if budget class still over, soft-stop
- `/budget $X` slash command: sets `dailyBudget` and prompts for mode if not set
- `CostEvent` from SPEC-701 feeds running daily total via in-memory sum (reset at UTC midnight)

### 2.2 Out-of-scope

- Weekly price-table refresh → deferred v0.2 (SPEC-701 handles static table)
- Multi-workspace budget aggregation → v0.3
- Forecasting + optimizer → v0.3
- Per-session budget (daily only in v0.2)

## 3. Constraints

### Technical

- Bun-native, TypeScript strict, max 400 LoC per file, no `any`
- `tiktoken` is a WASM npm package; verify Bun WASM compat before using (fallback `chars/4` if not)
- Budget enforcer must run synchronously in the agent loop before provider call

### Performance

- Token count <50ms for 8K-token prompt (Anthropic SDK call is async HTTP)
- Running-total lookup <1ms (in-memory Map)

### Resource / Business

- 1 dev part-time
- No new cloud dependency (token counter uses existing provider SDK)

## 4. Prior Decisions

- **Hi/lo band from P25/P90 history** — single-point estimates mislead; band gives user realistic range without needing a formal distribution model
- **`chars/4` fallback** — GPT tokenizer averages ~4 chars/token; good enough for budget gate on local models where cost is zero anyway
- **`fallback` downgrades model class, not specific model** — class mapping lives in SPEC-106 model router; estimator stays decoupled from model names
- **Daily budget resets at UTC midnight** — simplest boundary; per-session budget deferred because session length is unpredictable
- **`soft-stop` default when mode unset** — better than silently spending; less jarring than hard-stop for new users

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Token counter — multi-provider | Anthropic/OpenAI/local each return positive integer; chars/4 fallback tested | 40 | — |
| T2 | Estimator hi/lo band from history | P25/P90 computed over 20-event window; cold-start uses single-point | 30 | T1 |
| T3 | Budget config Zod schema + loader | Rejects negative budget; valid enum values; missing key → soft-stop default | 20 | — |
| T4 | Budget enforcer — 4 modes | Each mode triggers correct action; `fallback` retries with lower class | 50 | T2, T3 |
| T5 | `/budget $X` slash command | Sets dailyBudget in workspace.json; prompts mode; exit 0 | 20 | T3 |
| T6 | Fallback model downgrade | flagship→workhorse→budget chain; budget-class still over → soft-stop | 25 | T4 |
| T7 | Unit + integration tests | Estimator fixture; enforcer mode matrix; fallback chain | 80 | T1-T6 |

## 6. Verification

### 6.1 Unit Tests

- `tests/cost/estimator.test.ts`: Anthropic path returns numeric tokens; `chars/4` fallback for unknown provider; hi/lo band with 20-event fixture
- `tests/cost/budget.test.ts`: `warn` → no throw + banner emitted; `soft-stop` → prompt emitted; `hard-stop` → `NimbusError`; `fallback` → model class downgraded; fallback exhausted → soft-stop

### 6.2 E2E Tests

- `tests/e2e/budget-enforce.test.ts`: set `dailyBudget:0.001` hard-stop → next turn refused; increase budget → turn proceeds

### 6.3 Performance Budgets

- `bench/estimator.bench.ts`: token count <50ms for 8K prompt warm

### 6.4 Security Checks

- Budget config write goes through existing workspace path validator (no path traversal)
- No prompt content logged in estimator debug output

## 7. Interfaces

```ts
export interface TokenEstimate {
  inputTokens: number
  estimatedOutputTokens: number
  costLoUsd: number
  costHiUsd: number
}

export interface Estimator {
  estimate(
    messages: CanonicalMessage[],
    provider: string,
    model: string,
    workspaceId: string,
  ): Promise<TokenEstimate>
}

const BudgetConfigSchema = z.object({
  dailyBudget: z.number().min(0),
  mode: z.enum(['warn', 'soft-stop', 'hard-stop', 'fallback']).default('soft-stop'),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

export type BudgetDecision =
  | { action: 'proceed'; estimate: TokenEstimate }
  | { action: 'warn'; estimate: TokenEstimate; message: string }
  | { action: 'prompt'; estimate: TokenEstimate; message: string }
  | { action: 'block'; estimate: TokenEstimate; message: string }
  | { action: 'downgrade'; newModelClass: string; estimate: TokenEstimate }

export interface BudgetEnforcer {
  check(estimate: TokenEstimate, workspaceId: string): Promise<BudgetDecision>
  recordSpend(costUsd: number, workspaceId: string): void
  resetDaily(workspaceId: string): void
}
```

## 8. Files Touched

- `src/cost/estimator.ts` (new, ~70 LoC)
- `src/cost/budget.ts` (new, ~130 LoC)
- `tests/cost/estimator.test.ts` (new, ~80 LoC)
- `tests/cost/budget.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should `fallback` mode notify the user which model it downgraded to? (UX — likely yes, v0.2 default)
- [ ] Per-session budget as an opt-in alongside daily? (defer v0.3)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — cost estimator + 4-mode budget enforcer for v0.2
