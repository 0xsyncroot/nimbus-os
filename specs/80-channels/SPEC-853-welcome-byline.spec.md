---
id: SPEC-853
title: welcome-byline — Ink Welcome replaces welcome.ts + mascot.ts
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
implemented: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840]
blocks: []
estimated_loc: 80
files_touched:
  - src/channels/cli/ink/components/Welcome.tsx
  - src/channels/cli/welcome.ts
  - src/channels/cli/mascot.ts
  - tests/channels/cli/ink/components/Welcome.test.tsx
---

# welcome-byline — Ink Welcome Replaces welcome.ts + mascot.ts

## 1. Outcomes

- `nimbus init` and REPL session start display a visually polished welcome panel rendered via Ink.
- Wide terminals (cols≥70) show: `nimbus` ASCII banner, dim version string, `"What can I help with today?"` hint.
- Compact variant (session within 5 min of last session) shows a 3-line abbreviated panel — not a 1-liner.
- `NO_COLOR` degrades to plain `nimbus vX.Y.Z` text with no box-drawing or color.
- After migration, `welcome.ts` and `mascot.ts` are deleted from the codebase.

## 2. Scope

### 2.1 In-scope
- New `src/channels/cli/ink/components/Welcome.tsx` (~60 LoC).
- Wide variant: ASCII art banner + dim `vX.Y.Z` + hint text.
- Compact variant: 3-line panel (banner line + version + short hint) when `freshSession=true`.
- Plain fallback for `noColor=true` or `cols<40`: plain text, no box.
- `NO_COLOR` env var respected (mapped from `AppContext.noColor`).
- Delete `src/channels/cli/welcome.ts` and `src/channels/cli/mascot.ts` after migration (callers updated to use `<Welcome>`).

### 2.2 Out-of-scope (defer to other specs)
- `nimbus init` full Ink onboarding wizard → SPEC-855
- StatusLine / version display in footer → SPEC-848
- Theme token definitions → SPEC-840
- i18n of hint text → SPEC-854

## 3. Constraints

### Technical
- Bun ≥1.2; Ink 7 + React 19.
- TypeScript strict, no `any`.
- Max 400 LoC per file. `Welcome.tsx` target: ≤60 LoC.
- ASCII banner MUST be stored as a constant string (not computed); max 6 lines tall for narrow-terminal headroom.
- `ThemeProvider` tokens from SPEC-840 used for color; no hardcoded hex/ANSI.

### UX
- Wide variant: render only on first REPL open of a session, or after `/clear`.
- Compact variant: render on session start when previous session timestamp < 5 min ago.
- Both variants: banner width ≤68 chars to fit 70-col terminals.

## 4. Prior Decisions

- **3-line compact, not 1-liner** — gap audit noted the current 1-line repeat felt abrupt. 3 lines (banner + version + short hint) maintains visual rhythm without the full wide panel.
- **Delete `welcome.ts` + `mascot.ts` on migration** — not re-export wrappers. They are presentation files, not shared utilities; there are no non-REPL callers after SPEC-823 (welcome screen) is superseded by this spec.
- **`<Welcome>` is stateless** — receives `freshSession`, `version`, `noColor`, `cols` as props. No internal state or effects; trivial to test.
- **ASCII art as constant** — avoids font library dep. The banner is small (~6×8 chars); a bundled font would add ~100KB to the binary.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `<Welcome>` wide variant | Renders banner + version + hint at cols≥70; passes ink-testing-library snapshot | 35 | SPEC-840 T1 |
| T2 | `<Welcome>` compact + plain fallback | `freshSession=true` → 3-line; `noColor=true` → plain text; cols<40 → plain text | 25 | T1 |
| T3 | Migrate callers + delete legacy files | `welcome.ts` + `mascot.ts` deleted; `repl.tsx` (SPEC-851) and `init` entry use `<Welcome>` | 0 | T1, T2 |
| T4 | Unit tests | Wide, compact, noColor, narrow snapshots all pass | 30 | T1, T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/components/Welcome.test.tsx` (ink-testing-library):
  - Wide (cols=80, freshSession=false): contains banner, version string, hint.
  - Compact (cols=80, freshSession=true): 3 lines only, no full banner.
  - `noColor=true`: no ANSI codes, plain text only.
  - cols=38: plain text fallback.
  - Snapshot tests for each variant.

### 6.2 E2E Tests
- PTY smoke: `nimbus` REPL first open shows banner. Second open within 5 min shows compact. `NO_COLOR=1 nimbus` shows plain text.

### 6.3 Regression
- `grep -rn "welcome\|mascot" src/channels/cli/*.ts` = 0 after migration (legacy files gone).

## 7. Interfaces

```tsx
// src/channels/cli/ink/components/Welcome.tsx

interface WelcomeProps {
  version: string;
  /** True if previous session ended <5 minutes ago — triggers compact variant */
  freshSession: boolean;
  noColor: boolean;
  cols: number;
}

export function Welcome({ version, freshSession, noColor, cols }: WelcomeProps): React.ReactElement
```

```ts
// ASCII banner constant (stored in Welcome.tsx)
const BANNER_WIDE = `
 ███╗   ██╗██╗███╗   ███╗██████╗ ██╗   ██╗███████╗
 ████╗  ██║██║████╗ ████║██╔══██╗██║   ██║██╔════╝
 ██╔██╗ ██║██║██╔████╔██║██████╔╝██║   ██║███████╗
 ██║╚██╗██║██║██║╚██╔╝██║██╔══██╗██║   ██║╚════██║
 ██║ ╚████║██║██║ ╚═╝ ██║██████╔╝╚██████╔╝███████║
 ╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝╚═════╝  ╚═════╝ ╚══════╝
`.trim()
```

## 8. Files Touched

- `src/channels/cli/ink/components/Welcome.tsx` (new, ~60 LoC)
- `src/channels/cli/welcome.ts` (delete after migration)
- `src/channels/cli/mascot.ts` (delete after migration)
- `tests/channels/cli/ink/components/Welcome.test.tsx` (new, ~30 LoC)

## 9. Open Questions

- [ ] Light-theme variant of banner (different color token)? (defer to v0.4.1 light-theme work)
- [ ] Should hint text rotate from a small set of phrases? (nice-to-have, defer to v0.5)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — replaces SPEC-823/824 welcome screen specs with Ink-native version)
