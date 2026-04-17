---
id: SPEC-832
title: CLI UIHost — wrap existing readline picker (no Ink)
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3
layer: channels
pillars: [P3]
depends_on: [SPEC-830, SPEC-801]
blocks: []
estimated_loc: 180
files_touched:
  - src/channels/cli/ui/cliHost.ts
  - src/channels/cli/ui/picker.ts
  - src/channels/cli/repl.ts
  - src/tools/loopAdapter.ts
  - src/observability/errors.ts
  - tests/channels/cli/ui/cliHost.test.ts
  - tests/tools/loopAdapterHost.test.ts
---

# CLI UIHost — wrap existing readline picker (no Ink)

## 1. Outcomes

- CLI channel implements the `UIHost` contract from SPEC-830 by wrapping existing `confirm.ts` + `modelPicker.ts` — no Ink, no Yoga, no 4500-LoC terminal framework port (Expert 2 cost; Expert 4 plan §5 defer).
- 7 consecutive stdin-handoff regressions root cause addressed: single owner of stdin (the `UIHost`), picker/readline never reach into raw TTY concurrently (Expert 1 §V5).
- `loopAdapter.onAsk` now routes through `CliUIHost.ask()` for `confirm | pick | input` — same API surface Telegram uses.
- `NO_COLOR=1` + screen-reader prefixes preserved (SPEC-801 §1); behaviour unchanged for existing users.

## 2. Scope

### 2.1 In-scope
- `CliUIHost` implementing `UIHost` in `src/channels/cli/ui/uiHost.ts`
- Dispatch: `confirm` → refactored `confirm.ts`; `pick` → new `picker.ts` (readline-backed, numeric keys 1-9 + arrow-agnostic fallback); `input` → readline question; `status` → `process.stdout.write` with ANSI level prefix
- Single stdin-owner invariant: `UIHost.ask` acquires a lock; if another call is pending → throw `NimbusError(ErrorCode.U_UI_BUSY)` rather than silently racing
- Abort via `UIContext.abortSignal` → rejects with `{ kind: 'cancel' }`; timeout → `{ kind: 'timeout' }`
- Wire into `channels/cli/repl.ts` at REPL bootstrap: register `CliUIHost` with `ChannelRuntime`
- Retire ad-hoc `onAsk` CLI shaping in `loopAdapter` (Expert 1 §V2)
- Unit tests: stdin lock contention, abort semantics, NO_COLOR round-trip

### 2.2 Out-of-scope (defer to other specs)
- Ink / Yoga adoption → v1.0+ re-evaluation per Expert 4 (requires META-011 RFC)
- Mouse / Kitty / paste modes → same deferral (v1.0 Ink gate)
- Multi-line editor intent → v0.4
- `UIIntent.progress` for tool-call streaming → v0.4 with SPEC-806r fanout

## 3. Constraints

### Technical
- Use `node:readline` (Bun re-exports, see CLAUDE.md §4 — first-class, not a shim)
- No new npm deps; no Ink, no `ink-select-input`, no `figures`
- Max 400 LoC per file; picker expected ~120 LoC, uiHost ~60 LoC
- TTY detection via existing `colors.ts`; respect `NO_COLOR=1`

### Security
- Input via `input` intent with `secret: true` → echo-off (matches `nimbus key set` current behaviour)
- No execution of user input as shell (never eval, never template into Bash)

### Performance
- Picker render <50 ms for ≤20 options; fallback to text list when stdout is not a TTY
- Stdin lock contention is fail-fast (no queue) — matches Expert 1's "single owner" fix for the 7-regression class

## 4. Prior Decisions

- **No Ink** — Expert 2 quantified cost (~4500 LoC + 15 deps + Bun-macro blocker); Expert 4 cites plan §5 line 319 "Desktop native UI hold off to v1.0+"; SPEC-801 / SPEC-822 / SPEC-823 already reject Ink. Re-evaluate at v1.0 only.
- **Wrap, don't rewrite** — `confirm.ts` works; new `picker.ts` is a thin readline wrapper, not a TUI framework.
- **Single stdin owner** — fixes the 7 regressions (picker/readline fighting for raw mode). `UIHost` is the only code path allowed to `setRawMode`; REPL input becomes a consumer of `UIHost.input` too.
- **Fail-fast on lock contention** — queueing hides bugs; throw `U_UI_BUSY` loudly so we catch re-entrancy in tests.
- **No Ink port just for `bun:compile`** — Expert 2 confirms Claude Code uses Bun-macro `bun:bundle feature()` we don't have; porting Yoga + ink = 2578 + 2800 LoC pure TS.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `CliUIHost.ask` dispatch + stdin lock | Two concurrent `.ask()` → second throws `U_UI_BUSY` | 60 | SPEC-830 T2 |
| T2 | `picker.ts` readline-backed option selector | Numeric + fallback; NO_COLOR clean; abort works | 80 | T1 |
| T3 | Refactor `confirm.ts` behind UIHost | Existing CLI tests still green | 40 | T1 |
| T4 | Wire into `repl.ts` + retire `loopAdapter.onAsk` CLI shape | E2E PTY smoke: `y/n` prompt resolves | 30 | T2, T3 |
| T5 | Unit + PTY smoke tests | Lock contention, abort, timeout, NO_COLOR | 80 | T4 |

## 6. Verification

### 6.1 Gate A — Reviewer
- reviewer-architect: no `tools/` import in `channels/cli/ui/`; only `core/ui` + `node:readline`
- reviewer-performance: stdin raw-mode toggled exactly once per `ask()`; no leak on abort

### 6.2 Gate B — Real PTY smoke
- `scripts/pty-smoke` script: spawn compiled binary, trigger Bash `ask`, send `y\n` → tool executes, exit 0
- `NO_COLOR=1` env → no ANSI in captured output
- Ctrl-C during picker → `{ kind: 'cancel' }`, REPL returns to prompt cleanly

### 6.3 Gate C — CI
- `bun test tests/channels/cli/ui/` green on Linux + macOS + Windows
- `bun run typecheck` + `bun run spec validate` green
- PTY smoke runs in CI matrix

## 7. Interfaces

```ts
// src/channels/cli/ui/uiHost.ts
import type { UIHost } from '../../../core/ui';

export function createCliUIHost(deps: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  colorEnabled: boolean;
  logger: Logger;
}): UIHost;

// src/channels/cli/ui/picker.ts
export async function pickOption(args: {
  prompt: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  signal: AbortSignal;
  colorEnabled: boolean;
}): Promise<{ kind: 'ok'; id: string } | { kind: 'cancel' } | { kind: 'timeout' }>;
```

## 8. Files Touched

- `src/channels/cli/ui/uiHost.ts` (new, ~60 LoC)
- `src/channels/cli/ui/picker.ts` (new, ~120 LoC)
- `src/channels/cli/confirm.ts` (modify, refactor behind UIHost, ~30 LoC delta)
- `src/channels/cli/repl.ts` (modify, register host, ~20 LoC delta)
- `tests/channels/cli/ui/uiHost.test.ts` (new, ~50 LoC)
- `tests/channels/cli/ui/picker.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Expose `picker` arrow-key support via raw stdin? (v0.4 once lock invariant proven)
- [ ] Retire `modelPicker.ts` special case? (probably yes once SPEC-903 wires through UIHost — track in follow-up)

## 10. Changelog

- 2026-04-17 @hiepht: draft initial; explicitly defers Ink per Expert 2 cost + Expert 4 plan alignment
