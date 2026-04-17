---
id: SPEC-840
title: Ink 7 app bootstrap, theme tokens, base components
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-001, META-010, META-011]
blocks: [SPEC-841, SPEC-842, SPEC-843, SPEC-844, SPEC-845, SPEC-846, SPEC-847, SPEC-848, SPEC-849]
estimated_loc: 450
files_touched:
  - src/channels/cli/ink/app.tsx
  - src/channels/cli/ink/theme.ts
  - src/channels/cli/ink/components/Pane.tsx
  - src/channels/cli/ink/components/ThemedText.tsx
  - src/channels/cli/ink/components/Byline.tsx
  - src/channels/cli/ink/components/Divider.tsx
  - src/channels/cli/ink/components/StatusIcon.tsx
  - src/channels/cli/ink/components/Tabs.tsx
  - src/channels/cli/ink/components/KeyboardShortcutHint.tsx
  - tests/channels/cli/ink/foundation.test.ts
---

# Ink 7 App Bootstrap, Theme Tokens, Base Components

## 1. Outcomes

- Ink 7 app mounts cleanly via `renderApp()` in ~50ms warm; `AppContext` carries `{workspace, mode, locale, reducedMotion, noColor, cols, rows}` for all child components.
- `ThemeProvider` resolves the active palette from 4 themes (dark, light, dark-ansi, light-ansi); `useTheme()` hook returns typed `ThemeToken` → colour string for all child trees.
- 7 base components (`Pane`, `ThemedText`, `Byline`, `Divider`, `StatusIcon`, `Tabs`, `KeyboardShortcutHint`) render without errors under `ink-testing-library@4` smoke.
- `NO_COLOR=1` forces chalk level 0 from day 1; all ThemedText renders fall back to plain text.

## 2. Scope

### 2.1 In-scope

- `package.json` additions: `ink@7`, `@inkjs/ui@2`, `react@19.2`, `react-reconciler@0.29`, `@types/react`, `ink-testing-library@4`, `string-width@8`, `wrap-ansi@10`, `figures@6`, `cli-spinners@3` (pinned exact).
- `app.tsx` — root `<App>` component, `AppContext`, `renderApp()` factory; detects `reducedMotion`, `noColor`, `cols`/`rows` via Ink's `useStdout`/`useStdin` (not `ink-use-stdout-dimensions`).
- `theme.ts` — `ThemeToken` enum, 4-palette map, `ThemeProvider`, `useTheme()` hook.
- 7 component files under `src/channels/cli/ink/components/`.
- `foundation.test.ts` — `ink-testing-library` smoke for app mount, theme switch, each component renders, `NO_COLOR` path.

### 2.2 Out-of-scope

- `PromptInput` multi-line widget → SPEC-841.
- Slash autocomplete / help overlay → SPEC-842.
- Streaming output / markdown → SPEC-843.
- Modal alt-screen panels → SPEC-847.
- Keybinding manager → SPEC-849.

## 3. Constraints

### Technical

- Ink ≥7, React ≥19.2 hard peer. Node engine floor 22; Bun ≥1.3.5 satisfies both.
- React components: function components only, no class inheritance.
- `ink-use-stdout-dimensions` banned — open Bun segfault (bun#11013). Use Ink's built-in `useStdout()` instead.
- Max 400 LoC per file; `app.tsx` ~120, `theme.ts` ~100, components ~200 total.
- No `any` types. TypeScript strict throughout.
- `NO_COLOR` env → `chalk.level = 0`; set once at app init, never overridden.
- Layer rule (SPEC-833): `channels/cli/` must not import `tools/` directly.
- `bun.lockb` committed. Lockfile is updated only via `bun install`; `bun update` is forbidden in CI and local dev to prevent silent dep drift.
- CI audit gate: `.github/workflows/ci.yml` includes a `bun audit --prod` step. HIGH or CRITICAL severity findings in `ink`, `@inkjs/ui`, `react`, `marked`, `yoga-wasm-web`, or `react-reconciler` fail the build immediately.
- `@inkjs/ui` rot trigger: if a blocking bug is unaddressed upstream for 14 days OR the package has had no release within 18 months, vendor the widgets into `src/channels/cli/widgets/` and remove the package dep. Evaluate at each quarterly dep review.
- npm provenance check: `ink@7` and `@inkjs/ui@2` must present valid npm provenance attestation on install. If provenance is absent or invalid, CI aborts with an explicit error message.

### Performance

- App mount latency ≤50ms warm (measured via `performance.now()` around first `render(<App/>`).
- Ink runtime RSS overhead ≤8 MB over v0.3.20 baseline.

### Theme Palette

Dark palette reference (Claude Code research):
`claude rgb(215,119,87)` · `permission rgb(177,185,249)` · `error rgb(255,107,128)` · `success rgb(114,242,148)` · `warning rgb(255,204,102)` · `text rgb(240,240,240)` · `inactive rgb(128,128,128)` · `subtle rgb(100,100,100)`.
Light variant uses inverted-contrast equivalents. ANSI variants use terminal 16-colour codes.

## 4. Prior Decisions

- **Stock `ink@7` + `@inkjs/ui@2`, not Claude Code's in-tree fork.** The fork is ~20k LoC (mouse/search/Kitty). We defer those; stock Ink 7 is actively maintained (META-011 §4).
- **`useStdout()`/`useStdin()` instead of `ink-use-stdout-dimensions`.** The third-party hook has a confirmed Bun segfault (bun#11013); Ink's built-ins are safe and sufficient.
- **Pin deps exact.** `@inkjs/ui` 2-year-stale release is a risk; exact pins prevent silent drift. If it rots, vendor widgets into `src/channels/cli/widgets/` (META-011 §4).
- **4 themes from day 1.** `NO_COLOR` and `--ansi` are accessibility requirements; retrofitting them later breaks every component. Light theme ships with dark (open question META-011 §9 resolved pro-active).
- **Reference**: `src/` (Claude Code) patterns — `ink.tsx`, `components/ThemeProvider.tsx`, `utils/color.ts`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | Add deps + `bun install` | `bun install` exits 0; `import { render } from 'ink'` compiles | 0 (pkg only) | — |
| T2 | `app.tsx` — root + AppContext + renderApp | `renderApp()` returns unmount fn; AppContext resolves cols/rows/flags | 120 | T1 |
| T3 | `theme.ts` — ThemeToken + 4 palettes + provider + hook | `useTheme('claude')` returns correct hex in all 4 themes; `NO_COLOR` returns `''` | 100 | T2 |
| T4 | 7 base components | Each renders without throw under `ink-testing-library`; ThemedText respects `NO_COLOR` | 200 | T3 |
| T5 | `foundation.test.ts` — smoke suite | All tests green via `bun test`; `NO_COLOR=1` path asserted | 150 | T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/foundation.test.ts`: app mount, theme switch across 4 palettes, each component renders string output, `NO_COLOR=1` falls back to plain text.
- Each component test uses `ink-testing-library` `render()` + `lastFrame()` assertions.

### 6.2 Performance Budget

- `renderApp()` mount <50ms warm: `performance.now()` bench in test suite.
- Memory RSS delta ≤8 MB: asserted in Gate B PTY smoke (META-011 §6.3).

### 6.3 Layer Check

- `bun run lint` passes with SPEC-833 no-restricted-paths rules; no `channels/ → tools/` import.

### 6.4 CI

- `bun test tests/channels/cli/ink/` green on Linux + macOS + Windows.
- `bun run typecheck` green.

## 7. Interfaces

```ts
// src/channels/cli/ink/theme.ts
export type ThemeToken =
  | 'claude' | 'permission' | 'ide' | 'text' | 'inactive' | 'subtle'
  | 'suggestion' | 'remember' | 'background' | 'success' | 'error'
  | 'warning' | 'merged';

export type ThemeName = 'dark' | 'light' | 'dark-ansi' | 'light-ansi';

// src/channels/cli/ink/app.tsx
export interface AppContext {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  locale: 'en' | 'vi';
  reducedMotion: boolean;
  noColor: boolean;
  cols: number;
  rows: number;
}
export function renderApp(ctx: AppContext): { unmount: () => void }
```

## 8. Files Touched

- `src/channels/cli/ink/app.tsx` (new, ~120 LoC)
- `src/channels/cli/ink/theme.ts` (new, ~100 LoC)
- `src/channels/cli/ink/components/Pane.tsx` (new, ~25 LoC)
- `src/channels/cli/ink/components/ThemedText.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/Byline.tsx` (new, ~25 LoC)
- `src/channels/cli/ink/components/Divider.tsx` (new, ~20 LoC)
- `src/channels/cli/ink/components/StatusIcon.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/Tabs.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/KeyboardShortcutHint.tsx` (new, ~30 LoC)
- `tests/channels/cli/ink/foundation.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Ship light theme in v0.4.0 or defer to v0.4.1? (META-011 §9 — user decision pending)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-foundation; synthesized from META-011 + Claude Code UI research
- 2026-04-17 @hiepht: detail-pass — added lockb commit policy, CI `bun audit --prod` gate, `@inkjs/ui` rot trigger with 14d/18m thresholds, npm provenance check for ink@7 + @inkjs/ui@2; closed vendor-threshold open question
