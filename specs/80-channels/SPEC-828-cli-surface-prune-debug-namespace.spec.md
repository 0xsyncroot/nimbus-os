---
id: SPEC-828
title: CLI surface prune — dev verbs under `nimbus debug`
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3.9
layer: channels
pillars: [P6]
depends_on: [SPEC-801]
blocks: []
estimated_loc: 120
files_touched:
  - src/cli.ts
  - src/cli/debug/index.ts
  - src/cli/debug/doctor.ts
  - src/cli/debug/trace.ts
  - src/cli/debug/audit.ts
  - src/cli/debug/metrics.ts
  - src/cli/debug/status.ts
  - src/cli/debug/health.ts
  - src/cli/debug/errors.ts
  - src/cli/debug/vault.ts
  - src/cli/debug/backup.ts
  - tests/e2e/cli-surface.test.ts
---

# CLI surface prune — dev verbs under `nimbus debug`

## 1. Outcomes

- `nimbus --help` shows ~6 user-facing verbs (init, key, chat, cost, telegram, daemon) instead of the current 14 — new users don't see scary "audit/trace/metrics/doctor/errors/health" at first glance.
- Power-user paths preserved: `nimbus debug doctor`, `nimbus debug vault reset`, etc. all still work.
- One-release compatibility: `nimbus doctor` prints a deprecation note + dispatches to `nimbus debug doctor`. Breaks at v0.5.
- New unified `nimbus check` subcommand — convenience wrapper that runs doctor + health + vault diagnose sequentially, one stdout section each.

## 2. Scope

### 2.1 In-scope
- Move files: `src/cli/commands/{doctor,trace,audit,metrics,status,health,errors,vault,backup}.ts` → `src/cli/debug/*.ts`.
- Add `src/cli/debug/index.ts` — dispatcher that routes `nimbus debug <verb> [...args]`.
- Update `src/cli.ts` top-level `case` switch: remove the 9 debug verbs from the main router, add `case 'debug':`. Keep aliases for `doctor` (deprecated).
- Add `case 'check':` in main router — calls doctor + health + vault diagnose in order.
- Redesign the `--help` banner text: group as `USER COMMANDS` + `DIAGNOSTICS` (just shows `nimbus check` + `nimbus debug --help`).
- Deprecation warning: if user runs `nimbus doctor` (old path), log a one-line stderr note "`nimbus doctor` is deprecated; use `nimbus debug doctor` or `nimbus check`. Will be removed in v0.5."

### 2.2 Out-of-scope (defer)
- Reshaping `nimbus cost` sub-commands → already user-facing, leave alone.
- Renaming `telegram` subtree → v0.4 when we generalize channels.
- Tab-completion scripts → v0.4 polish.

## 3. Constraints

### Technical
- File moves MUST preserve git history where possible (`git mv`).
- Help text is copy-tested (golden-file snapshot in E2E) — any drift fails CI.
- No functional change to any command — only surface rearrangement.
- Deprecation alias must NOT wire through the new `debug` dispatcher recursively (direct call to the underlying function to keep stack traces clean).

### Performance
- `nimbus --help` render unchanged (<20 ms).

### Resource / Business
- Independent of SPEC-153 and SPEC-904 — can ship in parallel. No shared files with those specs.

## 4. Prior Decisions

- **Move files, don't just re-label in help** — hiding verbs in help but leaving them at top-level preserves the temptation to type `nimbus audit` and confuses both users and maintainers. Physical relocation makes the boundary real.
- **`nimbus debug` is a visible namespace, not hidden** — users who need it can still discover via `nimbus debug --help`. Hiding entirely (e.g., env-gated) would frustrate power users.
- **Keep one deprecated alias (`doctor`)** — it's the only legacy verb users actually used in the wild per onboarding feedback. `audit/trace/metrics/status/health/errors/vault/backup` were never surfaced in onboarding docs so no alias needed.
- **`nimbus check` is a user verb, not dev** — it answers "is my setup OK?" which is a first-class user concern. Composes doctor+health+vault diagnose internally but presents one clean output.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `git mv` 9 command files into `src/cli/debug/` | Imports updated; `bun run typecheck` clean | 10 | — |
| T2 | Create `src/cli/debug/index.ts` dispatcher | Parses subcommand, forwards args, prints its own `--help` | 40 | T1 |
| T3 | Update `src/cli.ts` main switch | Top-level case removed for 9 verbs; add `debug`, `check`, `doctor` (deprecated) | 30 | T2 |
| T4 | Redesign `--help` banner | Golden-file E2E snapshot | 20 | T3 |
| T5 | Implement `nimbus check` composite | Calls doctor + health + diagnose; prints section headers | 25 | T2 |
| T6 | E2E snapshot tests | See §6 | 35 | T4, T5 |

## 6. Verification

### 6.1 Unit Tests
- N/A — this is a routing change, covered by E2E.

### 6.2 E2E Tests
- `tests/e2e/cli-surface.test.ts`:
  - `nimbus --help` → snapshot equals golden file (no `audit/trace/metrics/...` in top-level list)
  - `nimbus debug --help` → lists the 9 debug verbs
  - `nimbus debug doctor` → exits 0, same output as prior `nimbus doctor`
  - `nimbus doctor` → prints deprecation on stderr, exits 0 with doctor output on stdout
  - `nimbus check` → runs all three sections with clear headers
  - `nimbus audit` → exits non-zero with "unknown command; did you mean `nimbus debug audit`?"

### 6.3 Performance Budgets
- `nimbus --help` cold <50 ms (unchanged).

### 6.4 Security Checks
- None directly — surface rearrangement only. `vault reset` is still destructive and keeps its existing in-command confirmation.
- reviewer-security sign-off NOT required for this spec (no credential code touched).

## 7. Interfaces

```ts
// src/cli/debug/index.ts
export async function runDebug(argv: readonly string[]): Promise<number>;

// src/cli.ts (excerpt)
case 'debug': return runDebug(rest);
case 'check': return runCheck(rest); // composite
case 'doctor': {
  process.stderr.write(
    'note: `nimbus doctor` is deprecated; use `nimbus debug doctor`. Removed in v0.5.\n',
  );
  return (await import('./cli/debug/doctor.ts')).runDoctor(rest);
}
```

## 8. Files Touched

- `src/cli.ts` (edit, ~30 LoC delta)
- `src/cli/debug/index.ts` (new, ~40 LoC)
- `src/cli/debug/*.ts` (moved, import-path updates only, ~10 LoC delta total)
- `src/cli/commands/*.ts` (deleted — moved to debug/)
- `tests/e2e/cli-surface.test.ts` (new, ~80 LoC)
- `tests/e2e/cli-surface-help.golden.txt` (new golden file)

## 9. Open Questions

- [ ] Should `nimbus check` auto-probe provider connectivity (1-token ping)? — Propose NO for v0.3.9 (network cost); add as `--live` flag in v0.4.

## 10. Changelog

- 2026-04-17 @hiepht: draft (v0.3.9 — declutter first-run help screen; preserve power-user paths)
