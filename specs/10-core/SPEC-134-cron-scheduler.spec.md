---
id: SPEC-134
title: Cron scheduler — periodic hooks with recovery
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P3, P4]
depends_on: [SPEC-118, SPEC-151, SPEC-701, META-003]
blocks: [SPEC-137, SPEC-139]
estimated_loc: 550
files_touched:
  - src/core/cron/scheduler.ts
  - src/core/cron/parser.ts
  - src/core/cron/persistence.ts
  - src/core/cron/jobRegistry.ts
  - tests/core/cron/scheduler.test.ts
  - tests/core/cron/parser.test.ts
  - tests/e2e/cron-recovery.test.ts
---

# Cron Scheduler — Periodic Hooks with Recovery

## 1. Outcomes

- nimbus can schedule arbitrary in-process jobs via `cron.add(id, expr, handler)` with standard 5-field cron syntax + `@hourly` / `@daily` / `@every <dur>` macros.
- A missed job (nimbus was offline during the fire time) is executed within 30s of daemon wake when `policy: 'catch-up'` is set; dropped silently when `policy: 'skip-past'`.
- Scheduler survives daemon restart via `~/.nimbus/workspaces/<id>/cron.jsonl` checkpoint (next-fire + last-success per job).
- Cost attribution: every cron-triggered LLM call carries `trigger: 'cron'` label so `nimbus cost` can show background spend separately.
- Unblocks SPEC-139 LearningEngine, SPEC-137 PatternObserver, and graduates SPEC-112 Dreaming from end-of-session to periodic.

## 2. Scope

### 2.1 In-scope

- `CronScheduler` singleton per daemon process (one scheduler, many jobs).
- Job registration API: `add({ id, expr, handler, policy, priority })`; idempotent by `id`.
- Cron expression parser: 5-field (min hour dom month dow) + macros (`@hourly`, `@daily`, `@weekly`, `@every 15m`).
- In-process scheduler loop: check pending jobs every 30s, fire with 5s jitter to smear cost spikes.
- Persistence: append-only JSONL of `{ jobId, nextFireAt, lastFireAt, lastSuccess, lastError? }`. On startup, rebuild next-fire from expr + now.
- Recovery policy enum: `'catch-up' | 'skip-past' | 'fire-once'`.
- Integration hook with SPEC-118 event bus: emit `cron.fired` / `cron.succeeded` / `cron.failed`.
- Integration with SPEC-701 cost tracker: any LLM call originating from a cron handler gets `costEvent.trigger = 'cron'` + `costEvent.jobId`.
- Kill switch: `CRON_DISABLED=1` env stops scheduler but keeps registration working (for dev/test).

### 2.2 Out-of-scope (defer)

- Distributed cron across multiple daemons → v0.6 (single-daemon only).
- Cron-as-user-feature (user writes cron in config) → v0.6; v0.4 exposes registration only to internal code (LearningEngine, Dreaming, SOUL-sampler).
- Timezone handling beyond `process.env.TZ` → v0.5.
- Per-job cost budget caps → v0.5 (rely on SPEC-702 global cap for now).

## 3. Constraints

### Technical

- Pure TypeScript, no npm cron library (`node-cron` / `cron` are Node-only quirks). Custom parser ~120 LoC.
- `setTimeout` not `setInterval` — reschedule after each fire to avoid drift.
- Max 50 jobs per workspace (guard against runaway registration).
- Job handlers MUST be async and return within 5 min (timeout → mark failed, emit event, continue).
- On crash inside a handler, scheduler MUST NOT crash: catch+log via pino.

### Performance

- Scheduler tick cost <5ms amortized (check 50 jobs × simple nextFire compare).
- Persistence write batched: 1 fsync per 30s tick, not per job.
- Daemon startup cost <100ms to rebuild state from cron.jsonl for 50 jobs.

### Resource

- Memory: in-memory job table + next-fire heap ≤ 20KB for 50 jobs.
- Disk: `cron.jsonl` rotates at 10MB (heal by keeping only latest entry per jobId).

## 4. Prior Decisions

- **Kill SPEC-117 idle-heartbeat once this lands.** SPEC-117 is a single-purpose timer; this scheduler generalizes it. Cron-based idle suggestion re-implemented as one registered job.
- **Custom parser vs library** — Bun-native, no deps, ~120 LoC is cheap; third-party cron libs drag Node-specifics and version risk.
- **Append-only JSONL vs SQLite** — consistent with SPEC-102 session storage; grep-friendly; crash-safe (no WAL torn writes).
- **30s tick granularity** — sub-minute scheduling is not a v0.4 need; matches typical cron usage; reduces wake-ups.
- **`catch-up` default for missed fires** — Dreaming / LearningEngine expect deterministic runs; if daemon was off for 8h, doing one catch-up run at wake is the right semantic (not 8 runs).
- **No user-facing cron yet** — exposing cron to user config grows attack surface + support burden; internal-only until usage patterns stabilize.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Cron expression parser | 5-field + 4 macros + `@every <dur>`; invalid → `NimbusError(P_CRON_PARSE)` | 120 | — |
| T2 | `nextFireAt(expr, from)` core | Returns next Date matching expr at/after `from`; DST-safe via UTC internally | 100 | T1 |
| T3 | Persistence layer | `load()` rebuilds from cron.jsonl; `checkpoint(jobId, state)` appends atomic | 90 | — |
| T4 | Scheduler loop + job registry | `add/remove/list`, 30s tick, jitter, handler timeout | 140 | T1, T2, T3 |
| T5 | Recovery policies | 3 policy branches handled on startup + on missed tick | 40 | T4 |
| T6 | Event bus + cost tracker integration | `cron.fired/succeeded/failed`; `costEvent.trigger='cron'` | 30 | T4, SPEC-118, SPEC-701 |
| T7 | Port SPEC-117 idle-heartbeat to cron job | Single registered job replaces old timer; SPEC-117 marked superseded | 30 | T4, T6 |

## 6. Verification

### 6.1 Unit Tests

- Parser: 5-field, `@hourly`, `@daily`, `@weekly`, `@every 15m`, `@every 1h30m`; invalid throws.
- `nextFireAt`: 20 fixtures covering month boundaries, leap year, DST spring-forward/fall-back (UTC-safe).
- Persistence: corrupt line mid-file → skip line, keep valid; rebuild state deterministic.
- Scheduler: 3 jobs registered, fake clock advance 1h → each fires correct number of times.
- Handler timeout: job that hangs 6min → marked failed at 5min, scheduler continues next tick.
- Handler throw: job that throws → marked failed, logged, NO process crash.
- Recovery `catch-up`: daemon "offline" 8h, job due hourly → 1 catch-up run, not 8.
- Recovery `skip-past`: same setup → 0 catch-up runs.

### 6.2 E2E Tests

- `tests/e2e/cron-recovery.test.ts`: spawn daemon, register job `@every 1m`, kill daemon, wait 3m, restart daemon → observe 1 catch-up fire within 30s.
- Compile binary, run 10-min scenario, assert `audit.jsonl` contains expected `cron.fired` events ±5s tolerance.

### 6.3 Performance Budgets

- Scheduler tick <5ms for 50 registered jobs.
- Startup rebuild <100ms for 50 jobs + 1000 historical entries.
- Memory: steady-state heap delta <1MB after 1000 ticks.

### 6.4 Security Checks

- Job handlers execute under daemon's existing trust scope — no elevation.
- Cron.jsonl mode 0600 (consistent with session storage).
- No external input accepted (v0.4 scope is internal-only); user-cron config is out-of-scope thus not a surface.

## 7. Interfaces

```ts
import { z } from 'zod'

export const CronPolicySchema = z.enum(['catch-up', 'skip-past', 'fire-once'])
export type CronPolicy = z.infer<typeof CronPolicySchema>

export const CronJobSpecSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/),
  expr: z.string().min(1).max(128),
  policy: CronPolicySchema.default('catch-up'),
  priority: z.number().int().min(0).max(100).default(50),
})
export type CronJobSpec = z.infer<typeof CronJobSpecSchema>

export type CronHandler = (ctx: CronFireContext) => Promise<void>

export interface CronFireContext {
  jobId: string
  firedAt: Date
  scheduledFor: Date
  isCatchUp: boolean
  workspaceId: string
}

export interface CronScheduler {
  add(spec: CronJobSpec, handler: CronHandler): void
  remove(id: string): boolean
  list(): Array<{ spec: CronJobSpec; nextFireAt: Date; lastSuccess?: Date; lastError?: string }>
  start(): Promise<void>
  stop(): Promise<void>
}

export type CronEvent =
  | { type: 'cron.fired'; jobId: string; at: string }
  | { type: 'cron.succeeded'; jobId: string; durationMs: number }
  | { type: 'cron.failed'; jobId: string; errorCode: string; errorMessage: string }
```

## 8. Files Touched

- `src/core/cron/scheduler.ts` (new, ~180 LoC)
- `src/core/cron/parser.ts` (new, ~120 LoC)
- `src/core/cron/persistence.ts` (new, ~90 LoC)
- `src/core/cron/jobRegistry.ts` (new, ~80 LoC)
- `src/core/cron/index.ts` (new, ~30 LoC — public API barrel)
- `tests/core/cron/scheduler.test.ts` (new, ~200 LoC)
- `tests/core/cron/parser.test.ts` (new, ~150 LoC)
- `tests/e2e/cron-recovery.test.ts` (new, ~100 LoC)

## 9. Open Questions

- [ ] Should the scheduler expose `pause(jobId)` / `resume(jobId)` API? (lean yes if LearningEngine wants to pause during high-cost sessions)
- [ ] Node-cron-style `@reboot` semantics — worth supporting for a "once at daemon wake" hook? (lean defer; `policy: 'fire-once'` + a boot-time `add()` covers it)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — synthesis of Expert C pattern-reuse proposal + Expert B LearningEngine dependency + supersede of SPEC-117 idle-heartbeat per mediator ruling.
