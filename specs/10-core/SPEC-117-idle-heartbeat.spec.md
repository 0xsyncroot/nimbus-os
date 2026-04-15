---
id: SPEC-117
title: Idle heartbeat — soft suggestion on long REPL idle
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.2
layer: core
depends_on: [SPEC-102, SPEC-104, SPEC-501, SPEC-701, SPEC-801]
blocks: []
estimated_loc: 80
files_touched:
  - src/context/heartbeat.ts
  - tests/context/heartbeat.test.ts
---

# Idle Heartbeat

## 1. Outcomes

- When the REPL is idle >5 minutes, nimbus makes one lightweight Haiku-class call prompting itself: "based on MEMORY + recent session, anything worth surfacing while user is idle?"
- Output appended to session as a DIM-rendered soft suggestion tagged `[HEARTBEAT]`; user can press Enter to dismiss or reply to engage
- Implements the OpenClaw "heartbeat" pattern at v0.2 scale; the full daemon-driven heartbeat comes v0.4
- Disabled automatically in CI (`CI=1` env) and when `heartbeat: false` in workspace config — prevents cost regression for batch/test usage

## 2. Scope

### 2.1 In-scope
- Idle timer per REPL: resets on every user keystroke OR tool-start event; fires when `now - lastActivity > idleMs` (default 5min)
- One Haiku call per idle firing, with a minimal prompt assembling `MEMORY.md` excerpt + last 3 assistant turns + one question
- Append suggestion into session stream as event type `heartbeat.suggestion`; render inline DIM below the prompt line
- Max one suggestion per idle-cycle; next suggestion requires re-activity-then-idle
- Config knobs via SPEC-501: `heartbeat.enabled` (bool), `heartbeat.idleMs` (number), `heartbeat.maxPerHour` (default 4)
- Hard ceiling: never more than `maxPerHour` heartbeats in any rolling 60-min window (cost DoS guard)

### 2.2 Out-of-scope
- Daemon-driven heartbeat while REPL is closed → SPEC-4xx v0.4 daemon work
- Heartbeat as multi-turn autonomous planning → v0.5 Dreaming / autonomous goals
- Push notifications to external channels (Telegram wake) → v0.3 channel work

## 3. Constraints

### Technical
- Timer tied to REPL process lifetime; tearing down REPL cancels the timer (no zombie calls)
- Disable paths (all OR'd): `process.env.CI === '1'`, `heartbeat.enabled === false`, `--no-heartbeat` CLI flag, REPL running in non-TTY (stdin is pipe)
- Heartbeat call respects current session's PermissionMode — in `readonly` mode, still fires but suggestion is text-only (no tool-use chains)
- `CostEvent` attribution: `isDream: true`, `skillName: 'heartbeat'`

### Performance / Cost
- Budget <$0.001 per heartbeat (Haiku, ~1K in, 80 out)
- Hourly cap 4 → max $0.004/hour idle cost; ceiling across a day = $0.10 if REPL idle 24h (acceptable)

## 4. Prior Decisions

- **Haiku class only** — heartbeat is a nudge, not a reasoning chain; workhorse would waste money on surface-level "what's up"
- **DIM render, not modal** — must NEVER interrupt user typing; inline below prompt is ignorable, reply is opt-in
- **Rolling hourly cap, not daily** — daily caps are bursty-unfriendly; hourly ensures steady low ambient cost even across 24h idle
- **Non-TTY disable** — pipes indicate scripted use; heartbeat there is noise + cost
- **No tool calls in heartbeat turn** — suggestions are text-only; actually doing work while user away is surprise and risk (v0.4 daemon + user-approved autonomy)

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Idle timer + activity reset | Resets on keystroke; fires once per idle-cycle; test with mocked time | 20 | SPEC-801 |
| T2 | Heartbeat prompt builder | Includes MEMORY excerpt + last 3 turns; omits SOUL (identity, not material) | 20 | SPEC-104 |
| T3 | LLM call (Haiku) + suggestion event | Writes `heartbeat.suggestion` to session stream | 20 | SPEC-701 |
| T4 | Hourly cap enforcement | >4/hour → skip + log info; rolling window accurate across DST | 10 | — |
| T5 | Disable paths + render | CI, non-TTY, config, flag all skip; DIM render in REPL | 10 | SPEC-801 |

## 6. Verification

### 6.1 Unit Tests
- Timer: 5min inactivity → 1 fire; keystroke resets; never fires during active tool run
- Disable: CI=1 → 0 fires; `--no-heartbeat` → 0 fires; non-TTY stdin → 0 fires; `heartbeat.enabled:false` → 0 fires
- Cap: 5 triggers in 1 hour → 4 LLM calls + 1 skip event logged
- Render: suggestion inline DIM; user Enter/keystroke consumes it (event marked dismissed)
- Cost: each heartbeat emits CostEvent with `isDream: true`, `skillName: 'heartbeat'`

### 6.2 E2E Tests
- `tests/e2e/heartbeat.test.ts`: mock REPL idle 6min → single suggestion line appears; mock tty=false → no suggestion

### 6.3 Performance Budgets
- Timer overhead <1ms per activity event; heartbeat call <2s p95

### 6.4 Security Checks
- Suggestion content passes through same SENSITIVE_FIELDS redactor (agent might echo MEMORY line containing a secret-shape)
- Heartbeat NEVER runs tools in v0.2 (text-only output assertion)
- Permission mode read at heartbeat time, not cached (user could have `/mode readonly`'d before leaving)

## 7. Interfaces

```ts
export const HeartbeatSuggestionSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.number(),
  sessionId: z.string(),
  workspaceId: z.string(),
  type: z.literal('heartbeat.suggestion'),
  content: z.string(),
  dismissed: z.boolean().default(false),
  costUsd: z.number(),
})
export type HeartbeatSuggestion = z.infer<typeof HeartbeatSuggestionSchema>

export interface HeartbeatService {
  onActivity(): void                          // reset idle timer
  isEnabled(ctx: { config: NimbusConfig; tty: boolean; ci: boolean }): boolean
  fire(sessionCtx: SessionContext): Promise<HeartbeatSuggestion | null>
  stop(): void                                // on REPL teardown
}
```

## 8. Files Touched

- `src/context/heartbeat.ts` (~70 LoC)
- `tests/context/heartbeat.test.ts` (~150 LoC)

## 9. Open Questions

- [ ] Jitter the 5min so bursts of users don't sync-fire? (defer; single-user system, not a server)
- [ ] Allow heartbeat to mint a MEMORY observation directly? (lean no — user-visible is safer than silent writes)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
