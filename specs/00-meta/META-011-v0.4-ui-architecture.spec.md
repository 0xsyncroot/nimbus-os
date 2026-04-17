---
id: META-011
title: v0.4 CLI UI architecture — Ink port umbrella
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: meta
depends_on: [META-001, META-010, SPEC-833]
blocks: [SPEC-840, SPEC-841, SPEC-842, SPEC-843, SPEC-844, SPEC-845, SPEC-846, SPEC-847, SPEC-848, SPEC-849]
estimated_loc: 0
files_touched: []
---

# v0.4 CLI UI Architecture — Ink Port Umbrella

## 1. Purpose

Architecture + spec tree for v0.4 CLI UI uplift: port Claude Code's Ink/React UX onto nimbus-os CLI. Outcomes: visual parity across 30 patterns (spinner, mode badges, diff, alt-screen, sticky footer, narrow-breakpoints); single stdin owner (`internal_eventEmitter`); 8 alt-screen modals; `NO_COLOR` + reduced-motion; Gate B 4-smoke on Ink binary before tag.

## 2. Scope

### 2.1 In-scope (v0.4)

The 17 child SPECs below cover the full CLI UI uplift. Grouped into 5 phases, deliverable sequentially but reviewable in parallel:

- **Phase A — Foundation** (blocks all others)
  - `SPEC-840` Ink 7 app bootstrap + `@inkjs/ui` wiring + theme tokens + base components (`<Pane>`, `<ThemedText>`, `<Byline>`, `<Divider>`, `<StatusIcon>`) + testing infra (`ink-testing-library`).
- **Phase B — Input**
  - `SPEC-841` Multi-line `PromptInput` with paste preservation, history, mode prefixes (`/`, `@`, `!`, `#`), draft stash across Ctrl-C. Custom component — `@inkjs/ui TextInput` is single-line (ecosystem gap).
  - `SPEC-842` Slash autocomplete dropdown + `/help` overlay (tabs + commands + general) with category grouping.
- **Phase C — Output**
  - `SPEC-843` Streaming output: spinner (ping-pong frames + stall red + verb rotation), cached markdown (500 LRU + fast-path skip), tool-use block (⏺/● glyph), tool-result block.
  - `SPEC-844` `StructuredDiff` for Write/Edit/MultiEdit with colored +/- and narrow-fallback collapse; cached per hunk.
  - `SPEC-845` Collapsed Read/Search coalescing (back-to-back Read+Grep in one line) + progress indicators for background tasks.
- **Phase D — Dialogs**
  - `SPEC-846` `PermissionDialog` + per-tool request components (Bash, FileWrite, FileEdit, SedEdit, WebFetch, Notebook, Skill, ExitPlanMode). Sticky footer for long-plan cases.
  - `SPEC-847` Modal panels with alt-screen: `/help`, `/model`, `/cost`, `/memory`, `/doctor`, `/status`, `/export`, `/compact`. Full-screen takeover via DEC 1049 (guarded against ink#935 scrollback wipe).
- **Phase E — Status + Polish**
  - `SPEC-848` `StatusLine` (model · mode · $today · ctx%) + `PromptInputFooter` + `TaskListV2` rendering (max-display clamp, 30s recent-completed TTL, figures icons).
  - `SPEC-849` Meta-UX: narrow-breakpoints, `NO_COLOR`, reduced-motion spinner fallback, SIGWINCH re-layout, alt-screen enter/exit guards, synchronized-output (DECSET 2026) wrapper, Kitty keyboard opt-in, keybinding manager (contexts + reserved shortcuts + chord prefix).
- **Phase F — Key + Locale + Error UI** (post-Phase E addenda)
  - `SPEC-850` `keyPromptCore` — secure key prompt; fixes plaintext echo on fast-init.
  - `SPEC-851` `repl.ts` Ink integration — wires Ink lifecycle; `NIMBUS_UI=legacy` guard.
  - `META-012` UI error codes — `U_*` namespace extending META-003.
  - `SPEC-852` inline-error-dialog — `<ErrorDialog>` surfaces `NimbusError` without crash.
  - `SPEC-853` welcome-byline — Ink `<WelcomeByline>` replacing legacy `welcome.ts`.
  - `SPEC-854` locale-policy — locale detection, `vi`/`en` toggle, ICU budget, `string-width`.
  - `SPEC-855` ink-onboarding-rewrite — onboarding wizard in Ink; replaces `onboard/picker.ts`.

Total estimated LoC: ~2700 net (add ~3500 new, delete ~800 in `slashAutocomplete`, `onboard/picker`, `welcome`, `mascot`, dead `idleHeartbeat`, `diffAndWrite` graveyard).

### 2.2 Out-of-scope (v0.4 — defer or skip)

- Mouse selection + hit-testing — Claude Code's fork ships ~800 LoC (`hit-test.ts`, `selection.ts`). Skip.
- `onboard/picker.ts` is NOT deleted in v0.4. It is used by shipped SPEC-827, SPEC-832, SPEC-901 and cannot be removed until the full onboarding rewrite (SPEC-855) lands and Gate B smokes pass. Deletion deferred to v0.5.
- Kitty keyboard protocol + modifyOtherKeys — opt-in via `SPEC-849` only if terminal advertises support.
- iTerm2 progress OSC + tab status — nice-to-have, defer to v0.5.
- OSC clipboard writer (`setClipboard`) — defer to v0.5.
- Fullscreen transcript rewind (`ctrl+o` in Claude Code) + MessageSelector — defer to v0.5.
- In-TUI search highlight + quick-open dialog — defer to v0.5.
- Screen-reader ARIA fallback — not in Ink's surface; document as known limitation.
- NOT porting Claude Code's in-tree Ink fork (~20k LoC); using stock `ink@7` + `@inkjs/ui@2`.

## 3. Constraints

### 3.1 Technical

- Bun ≥1.3.5, Node engines ≥22 (Ink 7 floor), React ≥19.2. TypeScript strict, no `any`. Max 400 LoC per file.
- SPEC-833 layer rule: `channels/cli/` cannot import `tools/` directly. Function components only; no class inheritance.

### 3.2 Performance

- Startup overhead ≤50ms warm (Ink app mount). `/help` modal first paint ≤30ms.
- Streaming frame rate: match rate of incoming deltas, no artificial buffering; sync-output (DECSET 2026) wrapper to batch per-animation-frame redraws.
- Markdown cache hit ≥90% for repeat renders of same assistant message.
- Memory overhead: Ink runtime adds ≤8 MB RSS over current `readline` path.

#### Numeric constants (pinned)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_STATIC_BLOCKS` | `500` | Max retained blocks in Ink `<Static>`; LRU-evict older entries |
| `FRAME_INTERVAL_MS` | `80` | Spinner animation interval (normal motion) |
| `REDUCED_MOTION_CYCLE_MS` | `2000` | Spinner cycle period when `prefersReducedMotion` |
| `STALL_THRESHOLD_MS` | `3000` | Duration before spinner turns red (stall indicator) |
| `STATUS_DEBOUNCE_MS` | `300` | StatusLine re-render debounce |
| `LARGE_PASTE_THRESHOLD_BYTES` | `10_000` | Paste above this size triggers chunked input handling |
| `FILE_REF_SCAN_TIMEOUT_MS` | `200` | Max time for `@`-file reference scan before fallback |

Additional perf budgets:
- Yoga re-flow ≤16ms at 200×60 terminal (full-width layout pass).
- Binary size cap ≤115MB after Ink + Yoga WASM bundled into compiled binary.

### 3.3 Resource / business

- 1 dev part-time (team-lead + spec-writer + developer). 2–3 weeks wall-clock under full-team workflow.
- Ship as `v0.4.0-alpha` first, then polish releases. Legacy raw-readline path kept behind `NIMBUS_UI=legacy` for 1 release.

### 3.4 Security (flagged from gap audit)

- `src/onboard/keyPrompt.ts` currently loses masking in fast-init when env var is pre-set — keys echo in plaintext. `SPEC-841` (prompt input) MUST fix this; no new path may bypass `PasswordInput` masking.
- Alt-screen entry/exit MUST be SIGINT-safe — if user Ctrl-Cs mid-modal, restore main screen cleanly (no garbled terminal).

## 4. Prior Decisions

- **Stock `ink@7` + `@inkjs/ui@2`, NOT Claude Code's fork.** Fork is 20k LoC (mouse/search/Kitty/iTerm2) deferred. `@inkjs/ui` replaces 6+ legacy pkgs; ~55 deps, 8–12 MB install (Yoga WASM in binary).
- **Framework solves stdin-ownership structurally.** `ink.tsx:internal_eventEmitter` keeps raw mode on across subtree transitions. Drain + 80ms priming in `onboard/picker.ts` deleted.
- **Custom multi-line input** — `@inkjs/ui TextInput` single-line (ink#660/676); build on `usePaste` (ink#921) + `string-width` (Vietnamese IME, ink#759).
- **Custom streaming markdown** — `ink-markdown` unmaintained; wrap `marked` streaming mode (~300 LoC), commit finished blocks to `<Static>`.
- **Custom alt-screen + sync-output wrapper** — ink#935 (scrollback wipe) open; DECSET 2026 for tmux (claude-code#37283).
- **PTY smoke** via `Bun.spawn({terminal})` (Bun 1.3.5+). NOT `node-pty` (bun#7362). `@lydell/node-pty` for Node CI fallback.
- **Pin deps exact.** Vendor `@inkjs/ui` widgets into `src/channels/cli/widgets/` if release rots before v1.0.
- **Legacy raw path behind `NIMBUS_UI=legacy`** for v0.4.0 only; removed in v0.4.1.
- **Hash function on render path: `Bun.hash` (wyhash).** Node fallback: non-crypto djb2. `sha256` forbidden on hot paths (exceeds 16ms Yoga budget at 200×60).

## 5. Task Breakdown

| ID | SPEC | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| ID | SPEC | Est LoC | Depends |
|----|------|---------|---------|
| T1 | SPEC-840 Foundation | 450 | — |
| T2 | SPEC-841 PromptInput | 500 | T1 |
| T3 | SPEC-842 Slash autocomplete + /help | 300 | T1 |
| T4 | SPEC-843 Streaming output | 400 | T1 |
| T5 | SPEC-844 StructuredDiff | 200 | T1 |
| T6 | SPEC-845 Collapsed Read/Search | 150 | T4 |
| T7 | SPEC-846 PermissionDialog | 500 | T1 |
| T8 | SPEC-847 Modal panels | 350 | T1 |
| T9 | SPEC-848 StatusLine + footer + TaskListV2 | 300 | T1 |
| T10 | SPEC-849 Meta-UX + keybinding manager | 250 | T1 |
| T11 | SPEC-850 keyPromptCore | 80 | T1 |
| T12 | SPEC-851 repl.ts Ink integration | 120 | T1, T2 |
| T13 | META-012 UI error codes | 50 | — |
| T14 | SPEC-852 inline-error-dialog | 100 | T1, T13 |
| T15 | SPEC-853 welcome-byline | 80 | T1 |
| T16 | SPEC-854 locale-policy | 120 | T1 |
| T17 | SPEC-855 ink-onboarding-rewrite | 350 | T1, T2, T11 |

Total ~4150 LoC new. After deleting ~800 LoC (drain/priming/dead code), net ~+2700.

## 6. Verification

### 6.1 Per-SPEC unit tests
Each child SPEC defines its own unit tests with `ink-testing-library`. Run via `bun test tests/channels/cli/`.

### 6.2 Gate B 4-smoke (mandatory before tag)

1. **PTY REPL smoke** — `Bun.spawn({terminal:{cols:80,rows:24}})`: Vietnamese paste, slash-command cycle, tool-confirm flow, `/clear`, resize 80→60→120.
2. **Real Telegram smoke** — unchanged from v0.3.18 protocol.
3. **Vault upgrade smoke** — unchanged.
4. **3-OS binary smoke via CD** — ubuntu-22.04, macos-14, windows-2022; `--version` + `--help` non-TTY pass.

### 6.3 Performance budgets

- Ink app startup: `<50ms` warm after `bun install`. Measured via `performance.now()` around `render(<App/>)`.
- Markdown cache hit ratio: `>=90%` on replay of a 10-turn session.
- Memory RSS: ≤8 MB incremental over v0.3.20 (`process.memoryUsage().rss` before/after first render).

### 6.4 UX parity checklist (all 30 takeaways from research)

Each applicable takeaway maps to a child SPEC acceptance criterion. Tracked in the test suite via `describe('Claude Code parity: takeaway #N', ...)`.

## 7. Interfaces

Cross-SPEC shared contracts:

```ts
// Theme tokens (SPEC-840)
export type ThemeToken =
  | 'claude' | 'permission' | 'ide' | 'text' | 'inactive' | 'subtle'
  | 'suggestion' | 'remember' | 'background' | 'success' | 'error'
  | 'warning' | 'merged';

// Ink app context (SPEC-840)
export interface AppContext {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  locale: 'en' | 'vi';
  reducedMotion: boolean;
  noColor: boolean;
  cols: number;
  rows: number;
}

// UIHost bridge (inherited from SPEC-830)
// Ink CliUIHost implements ask() by mounting <PermissionDialog> per intent.
```

## 8. Files Touched

See child SPECs. This umbrella alters no source files directly.

## 9. Open Questions

- [ ] Ship a light-theme variant alongside dark by v0.4.0, or defer to v0.4.1?
- [ ] Kitty keyboard protocol opt-in: auto-detect via capability probe, or env flag only?
- [ ] Mouse support — if users ask, re-open as v0.5 SPEC; currently out of scope.

## 10. Changelog

- 2026-04-17 @hiepht: draft created by team-lead (Opus synthesis of 3 Opus research reports: Claude Code UI catalog + nimbus gap audit + Ink ecosystem inventory).
- 2026-04-17 @hiepht: Phase 3 revisions — +7 new SPECs (SPEC-850–855, META-012) from reviewer gaps; perf constants pinned; onboard/picker delete deferred to v0.5; hash function policy added (Bun.hash/djb2, no sha256 on hot paths).
