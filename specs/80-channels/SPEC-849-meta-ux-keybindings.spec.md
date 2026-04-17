---
id: SPEC-849
title: Meta-UX helpers and keybinding manager
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-009, META-011, SPEC-840]
blocks: []
estimated_loc: 250
files_touched:
  - src/channels/cli/ink/breakpoints.ts
  - src/channels/cli/ink/altScreen.tsx
  - src/channels/cli/ink/syncOutput.ts
  - src/channels/cli/ink/keybindings/index.ts
  - src/channels/cli/ink/keybindings/defaultBindings.ts
  - src/channels/cli/ink/keybindings/resolver.ts
  - src/channels/cli/ink/keybindings/reservedShortcuts.ts
  - tests/channels/cli/ink/meta-ux.test.ts
---

# Meta-UX Helpers and Keybinding Manager

## 1. Outcomes

- `useBreakpoints()` hook returns `{isNarrow, isTight, isCompact}` based on terminal cols (`<120`, `<80`, `<60`); all layout-sensitive components consume it to degrade gracefully.
- `NO_COLOR=1` → `chalk.level = 0` at app init; `prefersReducedMotion` from env → spinner falls back to a 2s dim `●` cycle instead of animated frames.
- `<AltScreen>` wrapper enters DEC 1049 cleanly and restores main screen on SIGINT mid-modal with no garbled terminal (ink#935 guard).
- Keybinding manager resolves context stacks: deeper context wins; chord prefix timeout 1.5s; reserved shortcuts (ctrl+c, ctrl+d) cannot be rebound; user overrides loaded from `~/.nimbus/keybindings.json`.

## 2. Scope

### 2.1 In-scope

- `breakpoints.ts` — `useBreakpoints()` hook using `useStdout()` from Ink; thresholds 120/80/60 cols.
- `altScreen.tsx` — `<AltScreen>` with `useInsertionEffect` for DEC 1049 entry/exit; SIGINT-safe; guards against `CSI 3 J` (ink#935).
- `syncOutput.ts` — DECSET 2026 wrapper for tmux flicker-free output (claude-code#37283).
- `keybindings/index.ts` — `createKeybindingManager()` factory; `register()`, `resolve()`, `loadUserOverrides()`.
- `keybindings/defaultBindings.ts` — 9 contexts: Global, Chat, Autocomplete, Select, Confirmation, Scroll, HistorySearch, Transcript, Help.
- `keybindings/resolver.ts` — deeper context wins; chord prefix 1.5s timeout.
- `keybindings/reservedShortcuts.ts` — ctrl+c, ctrl+d routed to Ink default; blocks overrides.
- `tests/channels/cli/ink/meta-ux.test.ts` (~200 LoC).

### 2.2 Out-of-scope

- Mouse selection / hit-testing → out of scope for v0.4 (META-011 §2.2).
- Kitty keyboard protocol (`modifyOtherKeys`) → opt-in only if terminal advertises support; detection logic deferred.
- SIGWINCH re-layout — Ink handles automatically; documented but no extra code.
- iTerm2 progress OSC, OSC clipboard → deferred to v0.5.
- Full-screen transcript rewind (`ctrl+o`) → deferred to v0.5.

## 3. Constraints

### Technical

- `useInsertionEffect` for alt-screen entry (race-free; Claude Code `AlternateScreen.tsx`).
- Alt-screen exit MUST NOT emit `CSI 3 J` during active Ink render (ink#935 scrollback wipe).
- DECSET 2026 is tmux-only; skip when `$TERM` is not `screen*`/`tmux*`.
- Reserved ctrl+c, ctrl+d: `reservedShortcuts.ts` throws `NimbusError(ErrorCode.P_OPERATION_DENIED)` on override attempt.
- `keybindings.json` Zod-validated; unknown context keys → pino warning, not error.
- Max 400 LoC per file. No `any`. TypeScript strict. Layer rule (SPEC-833).

### Security (META-009)

- `keybindings.json` path is `~/.nimbus/keybindings.json` resolved via `SPEC-151` platform paths — no arbitrary file reads.
- Override keys validated against allowlist; arbitrary shell commands cannot be bound.

### Performance

- `useBreakpoints()` recalculates only on `SIGWINCH` (via Ink's `useStdout()` resize event); no polling.
- Chord prefix timeout 1.5s via `setTimeout`; cleared on next key or Esc.

## 4. Prior Decisions

- **`useInsertionEffect` not `useLayoutEffect` for alt-screen.** Race-free guarantee that entry/exit runs before paint; Claude Code `AlternateScreen.tsx` pattern.
- **DECSET 2026 for tmux only.** Unconditional emission breaks non-tmux terminals; detect `$TERM` at init (claude-code#37283).
- **9 keybinding contexts, not one flat map.** Modal-over-REPL layering resolves correctly; mirrors Claude Code `defaultBindings.ts:32-340`.
- **Reserved ctrl+c + ctrl+d.** Hard block — rebinding causes stuck processes; enforced at runtime + asserted in tests.
- **`~/.nimbus/keybindings.json`, not workspace-scoped.** Keybindings are user preference; workspace-scoping breaks cross-project users.
- **Reference**: Claude Code `src/` — `AlternateScreen.tsx`, `defaultBindings.ts:32-340`, `utils/terminal.ts`, `SyncOutput.tsx`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `breakpoints.ts` — `useBreakpoints()` hook | Returns correct booleans at cols 59/79/119/121; updates on resize event | 40 | SPEC-840 |
| T2 | `altScreen.tsx` — `<AltScreen>` with SIGINT guard | Enters + exits DEC 1049; SIGINT mid-render restores main screen; no `CSI 3 J` race | 80 | SPEC-840 |
| T3 | `syncOutput.ts` — DECSET 2026 wrapper | Emits only when `$TERM` is tmux/screen; no-op otherwise | 30 | — |
| T4 | `keybindings/` — manager + defaults + resolver + reserved | `resolve()` returns deeper-context binding; chord 1.5s timeout fires; ctrl+c block asserted | 150 | — |
| T5 | `meta-ux.test.ts` — full suite | All breakpoint, NO_COLOR, reducedMotion, altScreen, keybinding tests green | 200 | T1, T2, T3, T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/meta-ux.test.ts`: boundary cols breakpoints, NO_COLOR chalk level, reducedMotion spinner fallback, AltScreen SIGINT restore (mocked), DECSET 2026 tmux guard, keybinding context precedence, chord timeout, ctrl+c rebind throws.

### 6.2 Gate B PTY Smoke

- Resize 80→60→120 cols asserts re-layout (META-011 §6.2 step 5).
- Ctrl-C mid-modal restores terminal (no garbled output).

### 6.3 Security Check

- `keybindings.json` path traversal rejected (SPEC-151 path validator).
- Reserved keys throw on override attempt — test asserts `NimbusError(ErrorCode.P_OPERATION_DENIED)`.

### 6.4 CI

- `bun test tests/channels/cli/ink/` green on Linux + macOS + Windows.
- `bun run typecheck` green.

## 7. Interfaces

```ts
// src/channels/cli/ink/breakpoints.ts
export interface Breakpoints { isNarrow: boolean; isTight: boolean; isCompact: boolean }
export function useBreakpoints(): Breakpoints

// src/channels/cli/ink/keybindings/index.ts
export type KeybindingContext =
  | 'Global' | 'Chat' | 'Autocomplete' | 'Select'
  | 'Confirmation' | 'Scroll' | 'HistorySearch' | 'Transcript' | 'Help';

export interface KeybindingManager {
  register(context: KeybindingContext, key: string, action: string): void;
  resolve(contextStack: KeybindingContext[], key: string): string | undefined;
  loadUserOverrides(path: string): Promise<void>;
}
export function createKeybindingManager(): KeybindingManager
```

## 8. Files Touched

- `src/channels/cli/ink/breakpoints.ts` (new, ~40 LoC)
- `src/channels/cli/ink/altScreen.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/syncOutput.ts` (new, ~30 LoC)
- `src/channels/cli/ink/keybindings/index.ts` (new, ~40 LoC)
- `src/channels/cli/ink/keybindings/defaultBindings.ts` (new, ~60 LoC)
- `src/channels/cli/ink/keybindings/resolver.ts` (new, ~40 LoC)
- `src/channels/cli/ink/keybindings/reservedShortcuts.ts` (new, ~10 LoC)
- `tests/channels/cli/ink/meta-ux.test.ts` (new, ~200 LoC)

## 9. Open Questions

- [ ] Kitty keyboard opt-in: auto-detect capability probe or `NIMBUS_KITTY_KEYS=1` env only? (defer decision to v0.4.1)
- [ ] Should `~/.nimbus/keybindings.json` schema be versioned for forward-compat migration?

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-foundation; synthesized from META-011 + Claude Code AlternateScreen + defaultBindings research
