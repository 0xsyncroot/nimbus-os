---
id: SPEC-701
title: Cost v0.1 basic — track + ledger + price table
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: cost
depends_on: [SPEC-601, SPEC-151, SPEC-201]
blocks: []
estimated_loc: 350
files_touched:
  - src/cost/types.ts
  - src/cost/priceTable.ts
  - src/cost/accountant.ts
  - src/cost/ledger.ts
  - src/cost/aggregator.ts
  - src/cost/dashboard.ts
  - tests/cost/*.test.ts
---

# Cost v0.1 Basic (Track Only)

## 1. Outcomes

- Every LLM request records a `CostEvent` to `~/.nimbus/workspaces/{ws}/costs/YYYY-MM.jsonl` in <1ms
- Price table covers **5 providers × 9 models** with 2026 $/Mtok prices; fuzzy model match falls back to class default
- `nimbus cost --today|week|month` prints total USD + per-provider/per-session breakdown in <500ms for 90d data
- Accurate within ±0.01c per request for Anthropic prompt caching (read/write tokens priced separately)

## 2. Scope

### 2.1 In-scope
- `CostEvent` Zod schema per plan §12
- `priceTable.ts`: 2026 prices for Anthropic (opus-4-6, sonnet-4-5, sonnet-4-6, haiku-4-5), OpenAI (gpt-4o, gpt-4o-mini, o1), Groq (llama-3.3-70b), DeepSeek (v3), Ollama (any → 0)
- `accountant.recordCost(usage)` — single entry point called from provider adapters after LLM response
- `ledger.ts`: month-sharded JSONL writer + `_index.json` summary refresh
- `aggregator.ts`: in-memory rollup (by day/session/provider) with 5-min cache
- `cli.ts`: `nimbus cost [--today|--week|--month] [--by session|provider]`

### 2.2 Out-of-scope
- Estimator / pre-call prediction → v0.2
- Budget enforcement (warn/soft-stop/hard-stop/fallback) → v0.2
- Forecasting / optimizer → v0.3/v0.4
- Weekly price-table refresh cron → v0.2
- Export csv/json → v0.2

## 3. Constraints

### Technical
- Reference Claude Code patterns: `/root/develop/nimbus-cli/src/cost-tracker.ts` (event emitter), `/root/develop/nimbus-cli/src/utils/modelCost.ts` (pricing lookup)
- Append-only JSONL; rotate at month boundary
- Zod validates every CostEvent before write
- Retention 12 months, 50MB cap per workspace — SPEC-701 calls `SPEC-601 registerRetention({stream:'cost', days:365, maxMb:50, perWorkspace:true})` at module init so housekeeper honors cost-specific budget (not the 30d metrics default)

### Performance
- `recordCost()` p99 <1ms (synchronous format + buffered write)
- `nimbus cost --month` on 90d data <500ms
- Price lookup <0.1ms (Map-based)

## 4. Prior Decisions

- **5 providers × 2026 prices concrete, not pluggable registry** — v0.1 scope; weekly refresh cron v0.2
- **Fuzzy match by model class** — `claude-3-7-sonnet-xyz` → sonnet class default; unknown → warn once + price 0
- **Per-workspace ledger** — user isolation; multi-workspace roll-up is `aggregator` concern
- **JSONL not SQLite** — consistent with sessions + metrics; grep-friendly for debug
- **Track only v0.1** — budget enforcement risks breaking user flow without mature UX; v0.2 adds modes

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | `CostEvent` Zod schema | Fixture roundtrip; required fields enforced | 40 | — |
| T2 | `priceTable.ts` + fuzzy match | 2026 table hardcoded; unknown model → class default + warn once | 60 | — |
| T3 | `accountant.recordCost()` | Computes usd from usage+model; emits event | 60 | T1, T2 |
| T4 | `ledger.ts` JSONL writer | Month-sharded, `_index.json` refresh on flush | 70 | T1 |
| T5 | `aggregator.ts` in-memory rollup | 5-min cache, group by day/session/provider | 60 | T4 |
| T6 | `nimbus cost` CLI | `--today|week|month`, `--by session|provider` subcommand | 60 | T5 |

## 6. Verification

### 6.1 Unit Tests
- `priceTable.test.ts`:
  - Exact match: `opus-4-6` @ 1M in + 1M out = $15 + $75 = $90
  - Cache read: `opus-4-6` @ 1M cacheRead = $1.5 (10% base)
  - Fuzzy: `claude-sonnet-4-5-preview` → sonnet workhorse tier
  - `ollama/llama3` → $0 (all zeros)
  - `unknown-model-x` → warn + $0
- `accountant.test.ts`: 
  - Input 1000, output 500, cacheRead 2000 on sonnet-4-6 → cost = 3×0.001 + 15×0.0005 + 0.3×0.002 = $0.0111
  - `costSavedUsd`: same 2000 cacheRead tokens priced at base-input rate ($0.006) vs cache-read rate ($0.0006) → `costSavedUsd` = $0.0054 recorded in event
- `ledger.test.ts`: month rollover creates new file; `_index.json` sums match
- `aggregator.test.ts`: `--by provider` sums match raw ledger
- `cli.test.ts`: output format + exit code 0

### 6.2 E2E Tests
- `tests/e2e/cost-track.test.ts`: run 3 turns across providers → `nimbus cost --today` shows total and breakdown

### 6.3 Performance Budgets
- `bench/cost.bench.ts`: `recordCost()` avg <0.5ms; aggregate 90d <500ms

### 6.4 Security Checks
- No user content (prompt/response) in ledger
- Cost CLI output sanitizes session IDs (first 8 chars) by default

## 7. Interfaces

```ts
export const CostEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  ts: z.number(),
  workspaceId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  channel: z.string(),
  skillName: z.string().optional(),
  toolName: z.string().optional(),
  provider: z.enum(['anthropic','openai','groq','deepseek','ollama']),
  model: z.string(),
  modelClass: z.enum(['flagship','workhorse','budget','reasoning','local']),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  reasoningTokens: z.number().default(0),   // populated by SPEC-206: Anthropic thinking stream tokens + OpenAI o-series reasoning usage
  costUsd: z.number(),
  costSavedUsd: z.number().default(0),
  isDream: z.boolean().optional(),
  isMicrocompact: z.boolean().optional(),
})
export type CostEvent = z.infer<typeof CostEventSchema>

// --- priceTable.ts — 2026 USD per million tokens ---
export const PRICE_TABLE = {
  anthropic: {
    'opus-4-6':        { in: 15,   out: 75,  cacheRead: 1.5,  cacheWrite: 18.75, class: 'flagship' },
    'sonnet-4-5':      { in: 3,    out: 15,  cacheRead: 0.3,  cacheWrite: 3.75,  class: 'workhorse' },
    'sonnet-4-6':      { in: 3,    out: 15,  cacheRead: 0.3,  cacheWrite: 3.75,  class: 'workhorse' },
    'haiku-4-5':       { in: 1,    out: 5,   cacheRead: 0.1,  cacheWrite: 1.25,  class: 'budget' },
  },
  openai: {
    'gpt-4o':          { in: 2.5,  out: 10,  cacheRead: 1.25, cacheWrite: 0,     class: 'workhorse' },
    'gpt-4o-mini':     { in: 0.15, out: 0.60,cacheRead: 0.075,cacheWrite: 0,     class: 'budget' },
    'o1':              { in: 15,   out: 60,  cacheRead: 7.5,  cacheWrite: 0,     class: 'reasoning' },
  },
  groq: {
    'llama-3.3-70b':   { in: 0.59, out: 0.79,cacheRead: 0,    cacheWrite: 0,     class: 'budget' },
  },
  deepseek: {
    'v3':              { in: 0.27, out: 1.10,cacheRead: 0.07, cacheWrite: 0,     class: 'budget' },
  },
  ollama: {
    '*':               { in: 0,    out: 0,   cacheRead: 0,    cacheWrite: 0,     class: 'local' },
  },
} as const

export function lookupPrice(provider: string, model: string): Price
export function computeCost(usage: TokenUsage, provider: string, model: string): { costUsd: number; costSavedUsd: number }

// --- accountant.ts ---
export interface Accountant {
  recordCost(input: {
    workspaceId: string; sessionId: string; turnId: string
    provider: string; model: string
    usage: TokenUsage
    channel: string
    agentId?: string; parentAgentId?: string
    isDream?: boolean; isMicrocompact?: boolean
  }): Promise<CostEvent>
}

// --- aggregator.ts ---
export interface CostRollup {
  totalUsd: number
  byProvider: Record<string, number>
  bySession: Record<string, number>
  byDay: Record<string, number>
  events: number
}
export function aggregate(workspaceId: string, window: 'today'|'week'|'month'): Promise<CostRollup>
```

## 8. Files Touched

- `src/cost/types.ts` (~40 LoC)
- `src/cost/priceTable.ts` (~80 LoC)
- `src/cost/accountant.ts` (~60 LoC)
- `src/cost/ledger.ts` (~70 LoC)
- `src/cost/aggregator.ts` (~60 LoC)
- `src/cost/cli.ts` (~60 LoC)
- `tests/cost/` (~250 LoC)

## 9. Open Questions

- [ ] Should Ollama report compute-equivalent "shadow cost" for comparison? (v0.3)
- [ ] Sub-agent attribution display default (roll-up vs flat) — settled: roll-up default, `--by agent` drill

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — explicit `registerRetention()` call to SPEC-601 for 12mo cost budget; `costSavedUsd` test case added
- 2026-04-15 @hiepht: document `reasoningTokens` population via SPEC-206 (Anthropic thinking stream + OpenAI o-series reasoning usage); field already existed, this adds integration contract
