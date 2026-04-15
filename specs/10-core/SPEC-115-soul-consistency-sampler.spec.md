---
id: SPEC-115
title: SOUL consistency sampler — voice/value drift detector
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.3
layer: core
depends_on: [META-005, META-009, SPEC-104, SPEC-601]
blocks: []
estimated_loc: 180
files_touched:
  - src/context/consistencyChecker.ts
  - tests/context/consistencyChecker.test.ts
---

# SOUL Consistency Sampler

## 1. Outcomes

- On roughly 1 in 50 turns (sampling rate configurable), nimbus takes the assistant's reply and asks a small judge model to score alignment against the workspace SOUL.md on a 1-5 scale
- Score <3 emits a `SecurityEvent` (severity `warn`) + surfaces a one-time drift notice to user on next turn: "Voice/value drift detected in recent reply — see /audit"
- Cheap + low-noise: Haiku-tier judge, sampled 2%, costs <$0.05/day typical
- Addresses META-009 T-soft "SOUL drift" (agent gradually diverges from user's values over many sessions) without blocking normal turns

## 2. Scope

### 2.1 In-scope
- Per-turn sampler: draw random float, fire check when `< sampleRate` (default 0.02)
- Judge prompt builder: injects SOUL.md `# Values` + `# Communication Style` sections + assistant reply; returns JSON `{score: 1-5, reason: string}`
- Single LLM call via router pinned to `budget` class (`haiku-4-5` / `gpt-4o-mini` / `groq/llama-3.3-70b`)
- On score <3: emit `SecurityEvent(eventType:'drift_detected', severity:'warn', payloadDigest: sha256(reply))` per SPEC-601 (payload digest only, not raw reply — privacy + tamper evidence)
- On score <3: set a session flag; on NEXT user turn, prepend a banner `[DRIFT] recent reply scored X/5 vs SOUL — /audit for details`; banner fires once per session
- Config: `consistency.enabled` (default true), `consistency.sampleRate` (default 0.02), `consistency.judgeModel` (default 'budget')

### 2.2 Out-of-scope
- Auto-correction or rewrite of the drifting reply → never (agent can't edit past output without user consent; too risky)
- Monthly drift trend dashboard → v0.4 observability CLI
- Score SOUL.md itself for quality → v0.5 (SOUL curation tool)

## 3. Constraints

### Technical
- Judge call asynchronous, never blocks the user turn; fire-and-forget with 20s timeout
- Judge failure → log `T_TIMEOUT` warn, skip this sample (consistency is monitoring, not correctness)
- Sampler seeded from `crypto.randomUUID` hash to prevent correlated misses across workspaces

### Security
- NEVER include user prompt in judge call — only assistant reply + SOUL excerpt (privacy: user content stays in session)
- SecurityEvent records `payloadDigest` not raw reply (per SPEC-601 hash chain; avoids audit file becoming a reply log)
- Judge model fixed-pin within session to prevent rolling model swap mid-session skewing scores

## 4. Prior Decisions

- **2% sample, not per-turn** — per-turn doubles cost; 2% catches drift over a week
- **1-5 score, not pass/fail** — threshold 3 (1-2 drift, 3 ambiguous, 4-5 aligned)
- **Budget judge** — style/values within Haiku's capability; cost discipline
- **META-009 T-soft** — reliability concern, not security breach; `warn` severity
- **Banner next turn, fire-and-forget this turn** — UX stays instant
- **Once-per-session banner** — repeated noise annoys; `/audit` for full detail

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Sampler + seeded RNG | Deterministic given seed; 2% rate hit-count within CI tolerance | 20 | — |
| T2 | Judge prompt + JSON parse | Malformed JSON → re-prompt once; still bad → skip + warn | 50 | SPEC-104 |
| T3 | Judge LLM call | 20s timeout; budget class pin; cost recorded via `SPEC-701` with `isDream:true` | 40 | SPEC-701 |
| T4 | SecurityEvent emit + session banner state | <3 score → event + flag; next turn reads + clears flag | 40 | SPEC-601 |
| T5 | Config wiring + enable/disable | `/mode` unchanged; suppressed when `consistency.enabled: false` | 30 | SPEC-501 |

## 6. Verification

### 6.1 Unit Tests
- Sampler: rate 1.0 → 100 fires in 100 turns; 0.0 → 0 fires
- Prompt: contains SOUL.md Values + Style sections AND reply; does NOT contain user prompt
- Parse: valid `{"score":2,"reason":"..."}` → threshold triggered; missing field → re-prompt; invalid twice → skip
- Event: score 2 → `SecurityEvent.severity === 'warn'`, `eventType === 'drift_detected'`, `payloadDigest.length === 64`
- Banner: next turn starts with `[DRIFT]` prefix; second next turn does NOT (once-per-session)
- Disabled: `consistency.enabled: false` → no call, no event

### 6.2 E2E Tests
- `tests/e2e/consistency-drift.test.ts`: synthetic reply violating SOUL values → judge returns 2 → SecurityEvent present in security stream with digest matching expected SHA-256

### 6.3 Performance Budgets
- Judge call p95 <2s; cost per call <$0.001 (Haiku, 2026 pricing on ~2K in + 100 out)
- Fire-and-forget overhead on sampling turn <5ms (RNG + promise)

### 6.4 Security Checks
- No raw user prompts ever sent to judge (test asserts prompt excludes user turn content)
- SecurityEvent payloadDigest stable across runs given same reply (reproducibility)
- Hash chain integrity preserved (verify prevHash linkage after drift event)

## 7. Interfaces

```ts
export const DriftScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  reason: z.string().min(3).max(500),
})
export type DriftScore = z.infer<typeof DriftScoreSchema>

export interface ConsistencyChecker {
  shouldSample(turnIndex: number): boolean       // pure, seeded
  buildJudgePrompt(reply: string, soul: SoulMd): string
  judge(prompt: string): Promise<DriftScore>     // LLM call, budget class
  onAssistantReply(sessionCtx: SessionContext, reply: string): Promise<void>  // entry
}
```

## 8. Files Touched

- `src/context/consistencyChecker.ts` (~120 LoC)
- `tests/context/consistencyChecker.test.ts` (~220 LoC)

## 9. Open Questions

- [ ] Expose drift history via `/audit --drift` — likely v0.4 when audit CLI lands
- [ ] Let user tune threshold per-workspace? (defer; 3 is a defensible default)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
