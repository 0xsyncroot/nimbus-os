# Cost

> Track token usage and USD spend. v0.1 is track-only; v0.2 adds budget + estimator; v0.4 adds optimizer.

## 1. Quick check

```bash
nimbus cost                    # today's spend + breakdown
nimbus cost --week             # 7-day window
nimbus cost --month            # current month
nimbus cost --by provider      # group by provider
nimbus cost --by session       # group by session
```

In REPL: `/cost` for a compact today-view.

## 2. Price table (2026, USD per million tokens)

| Provider | Model | Class | Input | Output | Cache read | Cache write |
|----------|-------|-------|------:|-------:|-----------:|------------:|
| Anthropic | opus-4-6 | flagship | $15.00 | $75.00 | $1.50 | $18.75 |
| Anthropic | sonnet-4-5 | workhorse | $3.00 | $15.00 | $0.30 | $3.75 |
| Anthropic | sonnet-4-6 | workhorse | $3.00 | $15.00 | $0.30 | $3.75 |
| Anthropic | haiku-4-5 | budget | $1.00 | $5.00 | $0.10 | $1.25 |
| OpenAI | gpt-4o | workhorse | $2.50 | $10.00 | $1.25 | — |
| OpenAI | gpt-4o-mini | budget | $0.15 | $0.60 | $0.075 | — |
| OpenAI | o1 | reasoning | $15.00 | $60.00 | $7.50 | — |
| Groq | llama-3.3-70b | budget | $0.59 | $0.79 | — | — |
| DeepSeek | v3 | budget | $0.27 | $1.10 | $0.07 | — |
| Ollama | * | local | $0 | $0 | $0 | $0 |

Prices refresh weekly via cron fetching `github.com/nimbus-os/price-table/main/2026.json` (v0.2). Unknown model → fallback to class default + warn once.

## 3. What gets recorded

Every LLM request writes one `CostEvent` to `~/.nimbus/workspaces/{ws}/costs/YYYY-MM.jsonl`. Fields include:

- Token counts: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`
- Cost: `costUsd`, `costSavedUsd` (cache read savings vs base input rate)
- Attribution: `workspaceId`, `sessionId`, `turnId`, `agentId`, `parentAgentId`, `skillName`, `toolName`, `provider`, `model`, `modelClass`
- Flags: `isDream` (consolidation, reflection, heartbeat, drift check), `isMicrocompact`

Retention: 12 months, 50MB cap per workspace. Older events pruned oldest-first.

## 4. Example math

Sonnet-4-6 turn: 1000 input, 500 output, 2000 cache-read tokens.

```
input:        1000 × $3.00 / 1M  = $0.003000
output:        500 × $15.00 / 1M = $0.007500
cache-read:   2000 × $0.30 / 1M  = $0.000600
total:                           = $0.011100
```

Cache savings: same 2000 tokens at base input rate would cost $0.006. `costSavedUsd` = $0.0054.

### Monthly estimate — average personal use

**Assumptions**: 100 turns/day, avg 2000 input + 500 output tokens per turn (long SOUL+MEMORY context), 80% cache hit rate from turn 2, 22 working days/month.

Sonnet-4-6 per turn with cache:
```
fresh input (20%):     400 × $3.00 / 1M  = $0.00120
cached input (80%):   1600 × $0.30 / 1M  = $0.00048
output:                500 × $15.00 / 1M = $0.00750
per-turn total:                          = $0.00918
```

Monthly: `0.00918 × 100 turns × 22 days ≈ $20.20/month` on Sonnet.

Same math on other classes:
- **Haiku** (budget): `$6.70/month` — good enough for Read/Grep/Glob-heavy workflows
- **Opus** (flagship): `$101/month` — use sparingly, reserve for hard reasoning
- **Groq llama-3.3-70b**: `$1.37/month` — free tier covers most personal use
- **Ollama**: `$0/month` — slower but no cap

Rule of thumb: **if you average <50 turns/day and use Sonnet, budget ~$10/month**. If you push heavy research sessions, budget $30-50.

## 5. Where your money goes (typical)

From a month of average personal use:
- **Agent turns**: 70-85% of spend. Most is input tokens (long context, SOUL/MEMORY prefix).
- **Consolidation** (v0.2): ~$0.002 per session, Haiku. Negligible.
- **Reflection** (v0.3): ~$0.01 per 50 turns. ~5% of spend at 200 turns/day.
- **Drift checks** (v0.3): 2% sample × Haiku ≈ $0.05/day worst case.
- **Heartbeat** (v0.2): capped at $0.10/day even if REPL idle 24h.
- **Dreaming** (v0.5): budgeted separately at $0.50/day max.

Sub-agents (v0.3) attributed to their parent by default. Drill in with `nimbus cost --by agent`.

## 6. Optimizing cost (v0.1 knobs)

### Use cache aggressively
Anthropic prompt caching saves 90% on repeated prefixes. nimbus already sets cache breakpoints at SOUL/TOOLS boundary. To maximize hit rate:
- Keep SOUL.md stable (every edit invalidates cache)
- Avoid frequent MEMORY.md rewrites mid-session
- Long sessions beat many short ones (cache amortizes)

### Pick the right model class
- Read/Grep/Glob + file listings: `budget` class
- Standard REPL turns: `workhorse`
- Hard reasoning only: `flagship`

Switch mid-session with `/model budget` / `/model workhorse`.

### Use Groq or DeepSeek for bulk reads
`llama-3.3-70b` on Groq is free tier + fast. Good for "read these 30 files and extract claims" type work where you don't need Opus-level reasoning.

### Ollama for privacy-critical or unlimited runs
Local, $0, but 2-10× slower on typical hardware. Good for overnight bulk jobs.

### Agent preset: "lean mode"
Set workspace config `modelClass: budget` + `thinking.budgetTokens: 0`. Cuts spend ~5× vs workhorse + thinking default.

## 7. Export

```bash
nimbus cost --export csv > march.csv       # (v0.2)
nimbus cost --export json > march.json     # (v0.2)
```

Until v0.2 exports land, grep the ledger:
```bash
cat ~/.nimbus/workspaces/personal/costs/2026-04.jsonl | jq '.costUsd' | paste -sd+ | bc
```

## 8. Budget modes (v0.2)

Four enforcement modes via `/budget` slash command:

| Mode | Behavior |
|------|----------|
| `warn` | Banner when % of daily limit hit; work continues |
| `soft-stop` | Confirm prompt at 100%: "over budget, continue? [y/N]" |
| `hard-stop` | Refuse new turns at 100%; `/budget raise` to continue |
| `fallback` | Auto-downgrade: workhorse → budget → Ollama; transparent |

Configure:
```bash
nimbus config set budget.daily.limit 5.00
nimbus config set budget.daily.mode soft-stop
```

Separate budget for Dreaming:
```bash
nimbus config set budget.dreaming.daily 0.50
```

## 9. Estimator (v0.2)

Before execution, estimator predicts cost range:
```
nimbus > research 3 laptop dưới 30M VND
[EST] P50 $0.08, P90 $0.18 (20 searches + 4K output on sonnet-4-6)
[EST] Under budget (today $0.42 / $5.00). Proceed.
```

Prediction uses:
- `countTokens` from Anthropic SDK (accurate)
- `tiktoken` for OpenAI (accurate)
- `chars / 4` fallback (±20% typical)

Warn threshold: `costHi > $0.20` or > remaining budget.

## 10. Optimizer rules (v0.4)

Automatic suggestions after each session:
- `downgrade-simple` — "last session had 15 Read/Grep turns on Opus; budget class would save 80%"
- `cap-output` — "output tokens exceeded 2× input 8 times; consider explicit concise instructions"
- `dream-too-often` — "consolidation triggered 5×/day; budget guard bumped to turns≥15"
- `cache-miss-rate` — "cache hit rate dropped to 40%; something invalidated the prefix"
- `sub-agent-spawned-too-many` — "32 sub-agents in 1 session; consider synthesizing manually"

Apply with `nimbus optimize --apply`. Dry-run by default.

## 11. Cross-workspace rollup

```bash
nimbus cost --month --all-workspaces       # sum across work + personal + research
nimbus cost --month --workspace work
```

Useful when managing multiple projects with separate budgets.

## 12. Cost attribution — who paid for what

Every CostEvent has `agentId` and `parentAgentId`. Sub-agents roll up to their parent by default. To drill in:

```bash
nimbus cost --today --by agent
```

Skills and tools are attributed via `skillName` / `toolName`:
```bash
nimbus cost --week --by skill
```

## See also

- [Getting started](./getting-started.md)
- [Providers](./providers.md) — model-class table + caching details
- [Security](./security.md)
- Pricing spec: `specs/70-cost/SPEC-701-cost-v01-basic.spec.md`
