---
id: SPEC-109
title: Environment snapshot minimal — per-turn context injection
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-005, SPEC-103, SPEC-105, SPEC-151]
blocks: []
estimated_loc: 60
files_touched:
  - src/core/environment.ts
  - tests/core/environment.test.ts
---

# Environment Snapshot Minimal

## 1. Outcomes

- `snapshotEnvironment(ctx)` returns an `EnvironmentSnapshot` object in <20ms per turn — called by SPEC-103 loop right before prompt assembly.
- SPEC-105 prompt backbone splices `[ENVIRONMENT]` block (NOT cacheable — goes below cache breakpoint 2 per META-005 §2.5) using the snapshot XML-serialized for LLM clarity.
- v0.1 fields included: `cwd`, `gitBranch`, `gitDirty`, `nowIso`, `lastFailedToolName?`. Absent fields omitted (don't emit empty tags — noise reduction for cache hit on systems without git).
- Zero throws on degraded environment (no git? no cwd? detached HEAD?) — always returns a valid snapshot; unknown fields become `undefined` and are skipped in serialize.

## 2. Scope

### 2.1 In-scope
- `snapshotEnvironment(ctx)` — composes snapshot from `process.cwd()` + git probe + injected clock + loop's `lastFailedTool` cursor.
- `serializeEnvironment(snap)` — returns the XML block body for prompt splice (string, stable format, deterministic field order).
- Git probe: `Bun.spawn(['git','rev-parse','--abbrev-ref','HEAD'])` + `git status --porcelain` (empty = clean). 100ms timeout via `signals.onInterrupt` parent abort.
- Injected `Clock.now()` from SPEC-151 signals family (reuse injection pattern from SPEC-107) for deterministic tests.

### 2.2 Out-of-scope
- Mailbox count, budget %, recent files, active goals → v0.2+ (need sub-agents / estimator / consolidation first).
- Filesystem watcher for `gitDirty` → v0.2 (v0.1 probes per-turn).

## 3. Constraints

### Technical
- Async function (git probe is spawn).
- TS strict, no `any`.
- Git probe failures treated as absence: `gitBranch: undefined`, `gitDirty: undefined`. Never throw.
- Serialized block size <1KB typical; cap at 4KB (truncate `cwd` if longer, append `...`).
- Every subprocess spawn honors `AbortSignal` (parent abort from SPEC-103 turn abort tree).

### Performance
- `snapshotEnvironment()` <20ms median (git probe dominates); if exceeds 100ms → cancel, return snapshot without git fields.
- `serializeEnvironment()` <1ms.

### Resource
- No caching in v0.1 (per-turn fresh probe keeps prompt accurate). v0.2 can cache with fs-watch invalidation.

## 4. Prior Decisions

- **Place `[ENVIRONMENT]` below cache breakpoint 2** — why: `nowIso` changes every turn; caching would blow cache hit rate on stable prefix. Confirmed by META-005 §2.5 "Dynamic below (NOT cached)".
- **Per-turn probe, no cache** — why: git branch + dirty can change between turns (user commits mid-session); fs-watch cache adds complexity disproportionate to v0.1 budget.
- **Omit absent fields, not emit empty tags** — why: shorter prompt + LLM treats absence correctly ("no git info" vs "git: empty"); also matches Claude Code pattern in `prompts.ts:864-914`.
- **100ms timeout for git probe** — why: slow filesystems (NFS) can hang `git` for seconds; losing env context is acceptable, blocking a turn is not.
- **`lastFailedToolName?` only (not error body)** — why: body can leak secrets/paths; name alone lets LLM avoid repeating. v0.2 adds `reason` once redaction exists.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `EnvironmentSnapshot` type + `snapshotEnvironment()` | async, returns valid snapshot even with no git; <20ms median | 30 | — |
| T2 | `serializeEnvironment()` | stable field order, omits absent, caps 4KB | 15 | T1 |
| T3 | Git probe with timeout + abort | `Bun.spawn` + `AbortSignal` race; 100ms deadline | 15 | T1 |
| T4 | SPEC-103 + SPEC-105 integration | loop calls snapshot each turn; prompts.ts splices serialized block below breakpoint 2 | 0 (cross-spec) | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/environment.test.ts`:
  - `describe('SPEC-109: environment')`:
    - Clean git repo fixture → `gitBranch: 'main', gitDirty: false`.
    - Dirty repo (touch a file) → `gitDirty: true`.
    - Non-git dir → `gitBranch: undefined, gitDirty: undefined` (no throw).
    - Detached HEAD → `gitBranch: 'HEAD'` (rev-parse output); test asserts.
    - Git probe hang (mocked spawn with 200ms sleep) → returns within ~100ms with git fields undefined.
    - `lastFailedToolName: 'Bash'` propagates into snapshot.
    - `serializeEnvironment()` on full snapshot: expected XML matches golden file.
    - Absent `lastFailedToolName` → tag omitted from serialized output.
    - `cwd` longer than 4KB → truncated with `...` suffix.

### 6.2 E2E Tests
- Covered via SPEC-103 loop test: mock provider captures `request.system`, asserts `<environment>` block present with current cwd.

### 6.3 Performance Budgets
- `snapshotEnvironment()` <20ms median via `bun:test` bench (100 iters, hot git cache).
- Hang case: cancel by 110ms (100ms budget + 10ms cleanup).

### 6.4 Security Checks
- `cwd` serialization escapes XML entities (`&lt;`/`&amp;`) — test with path `/tmp/a&b<c`.
- `lastFailedToolName` is from internal enum (tool names), not user input — no injection surface.
- Git probe uses explicit argv (not shell), immune to path-injection.

## 7. Interfaces

```ts
// environment.ts
export interface EnvironmentSnapshot {
  cwd: string
  gitBranch?: string              // undefined when not a git repo / probe timeout
  gitDirty?: boolean
  nowIso: string                  // ISO 8601, from injected clock
  lastFailedToolName?: string     // from SPEC-103 cursor
}

export interface SnapshotContext {
  clock?: { now(): number }       // injectable for tests
  abort?: AbortSignal
  lastFailedToolName?: string
}

export async function snapshotEnvironment(ctx?: SnapshotContext): Promise<EnvironmentSnapshot>

export function serializeEnvironment(snap: EnvironmentSnapshot): string
// Output format (stable):
// <environment>
//   <cwd>/path/to/dir</cwd>
//   <git branch="main" dirty="false"/>
//   <now>2026-04-15T10:23:00.000Z</now>
//   <lastFailedTool>Bash</lastFailedTool>
// </environment>

export const GIT_PROBE_TIMEOUT_MS = 100
export const CWD_MAX_BYTES = 4096
```

## 8. Files Touched

- `src/core/environment.ts` (new, ~60 LoC)
- `tests/core/environment.test.ts` (new, ~120 LoC)
- `tests/fixtures/environment/golden.xml` (new, serialization snapshot)

## 9. Open Questions

- [ ] Should `nowIso` use UTC or local TZ? **Default UTC** (ISO Z suffix) — avoids DST ambiguity in logs; LLM receives tz-agnostic timestamp.
- [ ] Cache snapshot within the same turn (multiple tool iterations)? v0.1: yes, cache for turn duration (one probe per turn, not per iteration). Confirm in implementation.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
