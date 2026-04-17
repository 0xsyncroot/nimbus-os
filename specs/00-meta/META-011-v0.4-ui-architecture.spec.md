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

Define the architecture + spec tree for v0.4 CLI UI uplift: port Claude Code's Ink/React UX onto nimbus-os CLI. Outcomes:

- Visual + interaction parity with Claude Code across 30 patterns (spinner, mode badges, diff, alt-screen modals, sticky footer, narrow-breakpoints).
- Zero v0.3.10–15 picker regressions via **single stdin owner** (`internal_eventEmitter`), never `setRawMode` torn down mid-session.
- Tool stream renders with spinner verb rotation, cached markdown (500 LRU), colored structured diff, collapsed Read/Search.
- 8 modal panels enter alt-screen + restore cleanly (no scrollback pollution, guarded against ink#935).
- Narrow-terminal degrades (`<120/80/60` cols). `NO_COLOR` + reduced-motion respected.
- Gate B 4-smoke (PTY + Telegram + vault + 3-OS) runs on Ink binary before tag.

## 2. Scope

### 2.1 In-scope (v0.4)

The 10 child SPECs below cover the full CLI UI uplift. Grouped into 5 phases, deliverable sequentially but reviewable in parallel:

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

Total estimated LoC: ~1800 net (add ~2600 new, delete ~800 in `slashAutocomplete`, `onboard/picker`, `welcome`, `mascot`, dead `idleHeartbeat`, `diffAndWrite` graveyard).

### 2.2 Out-of-scope (v0.4 — defer or skip)

- Mouse selection + hit-testing — Claude Code's fork ships ~800 LoC (`hit-test.ts`, `selection.ts`). Skip.
- Kitty keyboard protocol + modifyOtherKeys — opt-in via `SPEC-849` only if terminal advertises support.
- iTerm2 progress OSC + tab status — nice-to-have, defer to v0.5.
- OSC clipboard writer (`setClipboard`) — defer to v0.5.
- Fullscreen transcript rewind (`ctrl+o` in Claude Code) + MessageSelector — defer to v0.5.
- In-TUI search highlight + quick-open dialog — defer to v0.5.
- Screen-reader ARIA fallback — not in Ink's surface; document as known limitation.
- NOT porting Claude Code's in-tree Ink fork (~20k LoC); using stock `ink@7` + `@inkjs/ui@2`.

## 3. Constraints

### 3.1 Technical

- Runtime: Bun ≥1.3.5 (native Terminal API via `Bun.spawn({terminal})` for PTY smokes).
- Node engines: `>=22` (Ink 7 hard floor). Bun satisfies.
- React ≥19.2 peer of Ink 7. No concurrent-mode workarounds beyond what Ink supports.
- TypeScript strict, no `any`. Max 400 LoC per file.
- `SPEC-833` layer enforcement must NOT regress. `channels/cli/` cannot import `tools/` directly; tool events arrive via event bus + `ChannelService` port.
- Functional + closures, no class inheritance. React components = function components only.

### 3.2 Performance

- Startup overhead ≤50ms warm (Ink app mount). `/help` modal first paint ≤30ms.
- Streaming frame rate: match rate of incoming deltas, no artificial buffering; sync-output (DECSET 2026) wrapper to batch per-animation-frame redraws.
- Markdown cache hit ≥90% for repeat renders of same assistant message.
- Memory overhead: Ink runtime adds ≤8 MB RSS over current `readline` path.

### 3.3 Resource / business

- 1 dev part-time (team-lead + spec-writer + developer). 2–3 weeks wall-clock under full-team workflow.
- Ship as `v0.4.0-alpha` first, then polish releases. Legacy raw-readline path kept behind `NIMBUS_UI=legacy` for 1 release.

### 3.4 Security (flagged from gap audit)

- `src/onboard/keyPrompt.ts` currently loses masking in fast-init when env var is pre-set — keys echo in plaintext. `SPEC-841` (prompt input) MUST fix this; no new path may bypass `PasswordInput` masking.
- Alt-screen entry/exit MUST be SIGINT-safe — if user Ctrl-Cs mid-modal, restore main screen cleanly (no garbled terminal).

## 4. Prior Decisions

- **Stock `ink@7` + `@inkjs/ui@2`, NOT Claude Code's fork.** Fork is 20k LoC (mouse/search/Kitty/iTerm2) we defer. Stock Ink 7 actively maintained (Apr 2026). `@inkjs/ui` ships Spinner/Progress/TextInput/Password/Select/MultiSelect/Confirm/Alert/Badge — replaces 6+ legacy pkgs. ~55 transitive deps, 8–12 MB install (Yoga WASM bundled into compiled binary).
- **Framework solves stdin-ownership structurally.** Previous v0.3.18 "Ink wouldn't solve it" claim refuted by Claude Code's `ink.tsx:internal_eventEmitter`: raw mode stays on across subtree transitions; React routes subscription. Drain + 80ms priming in `onboard/picker.ts` deleted.
- **Custom multi-line input** — `@inkjs/ui TextInput` is single-line; ink#660 #676 open. Build on `usePaste` (ink#921) + `string-width` (Vietnamese IME, tracking ink#759).
- **Custom streaming markdown** — `ink-markdown` unmaintained ~2yr, doesn't tolerate partial blocks. Wrap `marked` streaming mode (~300 LoC); commit finished blocks to `<Static>`.
- **Custom alt-screen + sync-output wrapper** — ink#935 (scrollback wipe) open; defensive entry/exit guard. DECSET 2026 sync-output for tmux (claude-code#37283).
- **PTY smoke uses `Bun.spawn({terminal})`** (Bun 1.3.5+). NOT `node-pty` (broken per bun#7362). `@lydell/node-pty` reserved for Node CI fallback.
- **Pin deps exact**. `ink` + `@inkjs/ui` + `react`. `@inkjs/ui` 2-yr-stale release is risk — vendor widgets into `src/channels/cli/widgets/` if it rots before v1.0.
- **Legacy raw path behind `NIMBUS_UI=legacy`** for v0.4.0 only. Removed in v0.4.1 after 1 release of field validation.

## 5. Task Breakdown

| ID | SPEC | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | SPEC-840 Foundation | Ink app mounts, ThemeProvider renders, `bun test` + ink-testing-library green | 450 | — |
| T2 | SPEC-841 PromptInput | Multi-line, paste preserves, mode prefixes detected, draft survives Ctrl-C, password mode masks | 500 | T1 |
| T3 | SPEC-842 Slash autocomplete + /help | Dropdown renders, Tab accepts, Esc dismisses, /help shows categories + keybinding legend | 300 | T1 |
| T4 | SPEC-843 Streaming output | Spinner frames match Claude Code, markdown cache ≥90% hit, tool-use/result blocks render | 400 | T1 |
| T5 | SPEC-844 StructuredDiff | +/- colored, narrow-fallback collapses, cached per hunk | 200 | T1 |
| T6 | SPEC-845 Collapsed Read/Search | Back-to-back Read+Grep coalesce into 1 line, progress bars for background tasks | 150 | T4 |
| T7 | SPEC-846 PermissionDialog | 8 per-tool requests render, sticky footer for plan, Yes/Always/No cycle correct | 350 | T1 |
| T8 | SPEC-847 Modal panels | 8 alt-screen modals enter+restore, guarded against scrollback wipe | 350 | T1 |
| T9 | SPEC-848 StatusLine + footer + TaskListV2 | Status row shows model/mode/$today/ctx%, TaskList clamps to rows, recent-completed TTL | 300 | T1 |
| T10 | SPEC-849 Meta-UX + keybinding manager | NO_COLOR, reduced-motion, SIGWINCH, sync-output wrapper, keybinding contexts all pass unit tests | 250 | T1 |

Total ~3250 LoC new. After deleting drain/priming/dead code (~800 LoC), net ~+2450.

## 6. Verification

### 6.1 Per-SPEC unit tests
Each child SPEC defines its own unit tests with `ink-testing-library`. Run via `bun test tests/channels/cli/`.

### 6.2 Gate B 4-smoke (mandatory before tag)

1. **PTY REPL smoke** — `Bun.spawn({terminal:{cols:80,rows:24}})` spawns the compiled binary, drives:
   - Vietnamese multi-byte paste (`chào anh em`) + Enter
   - Slash command cycle (`/help` → Esc → `/model` → picker → Esc)
   - Tool confirm flow (mock a Write tool → Yes → ensure allowed)
   - `/clear` + Ctrl-L both redraw cleanly
   - Resize 80→60→120 cols, assert re-layout
2. **Real Telegram smoke** — unchanged from v0.3.18 protocol.
3. **Vault upgrade smoke** — unchanged.
4. **3-OS binary smoke via CD** — Ink binary runs on ubuntu-22.04, macos-14, windows-2022; `--version` + `--help` non-TTY pass.

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
