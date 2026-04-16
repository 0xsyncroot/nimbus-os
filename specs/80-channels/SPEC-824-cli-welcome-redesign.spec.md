---
id: SPEC-824
title: CLI welcome screen redesign — nimbus mascot pattern
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.2
layer: channels
depends_on: [SPEC-823]
blocks: []
estimated_loc: 140
files_touched:
  - src/channels/cli/mascot.ts
  - src/channels/cli/welcome.ts
  - src/channels/cli/colors.ts
  - tests/channels/cli/welcome.test.ts
  - tests/channels/cli/mascot.test.ts
---

## 1. Outcomes

- Mascot visible ≥90% user terminals (CP437-safe on Windows conpty, macOS Terminal, iTerm2, gnome-terminal)
- Two-column layout when cols ≥ 70; stacked when 40 ≤ cols < 70; plain below 40
- Welcome message personal: "Welcome back, {username}." fallback "Welcome to nimbus."
- UX qualitative: không còn cảm giác `neofetch` (table-like)

## 2. Scope

### 2.1 In

- 5-row nimbus mascot (cloud + crescent, 3-level shaded)
- Width-aware layout: wide ≥70 / stacked 40–69 / compact (returning <1h) / plain fallback
- Windows conpty UTF-8 safe (test smoke)

### 2.2 Out

- Animation, gradient sweep, emoji, figlet
- Right-column "recent activity" feed — defer v0.4 (needs session snapshot infra)
- Mascot pose swap / rotation

## 3. Constraints

- Bundle ≤ 200 LoC total (mascot.ts + welcome.ts combined)
- No new deps; use existing `colors.ts` EARTH_* palette
- No emoji, no animation, no gradient sweep
- No API break on `renderWelcome()`; `WelcomeInput` unchanged
- `NIMBUS_FORCE_WELCOME=full|compact|plain` env override preserved

## 4. Prior Decisions

- **Mascot = cloud + crescent moon** — Latin "nimbus" = cloud; moon-behind-cloud gives natural depth layer; cloud metaphor aligns with "AI OS drifting ambient"
- **3-level shading (`░▒▓█▓▒░`)** — matches Claude Code Clawd technique (`/root/develop/nimbus-cli/src/components/LogoV2/Clawd.tsx`), CP437-safe everywhere
- **70-col threshold** — matches Claude Code `logoV2Utils.ts:35` `HORIZONTAL_MIN_COLUMNS`
- **Rewrite not patch** — user feedback "quá xấu" = layout-level, full redo smaller LoC than incremental add-mascot-on-top-of-table
- **Cols<40 → plain (script-compat)** — preserve v0.3.1 `[OK]` contract for CI/scripts

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC |
|----|------|-----------|---------|
| T1 | `mascot.ts` — export `MASCOT_WIDTH=13`, `MASCOT_HEIGHT=5`, `renderMascot(): string[]` returning 5 colored lines | unit test: width, height, stripped length | 60 |
| T2 | `welcome.ts` — rewrite `renderFull()` as internal dispatcher: wide (cols≥70 → 2-col zip with mascot) vs stacked (mascot then text stacked) | snapshot pass both layouts | 35 |
| T3 | `welcome.ts` — rewrite `renderCompact()` to single line (no mascot) | snapshot | 15 |
| T4 | `pickVariant` — change narrow cutoff cols<40 → plain (was <60 in v0.3.1) | integration test | 5 |
| T5 | Tests — delete v0.3.1 snapshots (superseded); add 4 new (wide-80, stacked-50, compact, plain); property test stripAnsi.length ≤ cols | all pass | 25 |

## 6. Verification

### 6.1 Unit

- `welcome.test.ts`: 4 new snapshots (wide-80, stacked-50, compact, plain); width assertion for cols in [35, 50, 80, 120]
- `mascot.test.ts`: 5 lines returned; MASCOT_WIDTH===13; each stripped line length ≤13

### 6.2 Smoke

- Compile binary, manual verify via `COLUMNS=80|50|35|NO_COLOR=1`

## 7. Interfaces

```
Mascot ASCII (CP437-safe block chars):

  Row 1:    ░▒▓█▓▒░        (EARTH_LIGHT)
  Row 2:   ▒████████▒     (EARTH_LIGHT + EARTH_GOLD + EARTH_LIGHT)
  Row 3:  ░██▓▓▓▓▓██▌░   (EARTH_LIGHT + EARTH_GOLD + EARTH_DEEP + EARTH_GOLD + EARTH_LIGHT)
  Row 4:   ▀█▓▓▓▓▓▀      (EARTH_DEEP)
  Row 5:    ·  ·  ·       (EARTH_DIM)
```

```ts
// mascot.ts
export const MASCOT_WIDTH = 13;
export const MASCOT_HEIGHT = 5;
export function renderMascot(): string[];

// welcome.ts — unchanged signature
export function renderWelcome(input: WelcomeInput): string;
```

## 8. Files Touched

- `src/channels/cli/mascot.ts` — new ~60 LoC
- `src/channels/cli/welcome.ts` — modify ~50 LoC delta (rewrite renderFull + renderCompact)
- `src/channels/cli/colors.ts` — +2 LoC (export LAYOUT_WIDE_MIN = 70)
- `tests/channels/cli/welcome.test.ts` — update snapshots ~30 LoC delta
- `tests/channels/cli/mascot.test.ts` — new ~20 LoC

## 9. Open Questions

- [ ] Mascot chosen = cloud+crescent; can be reviewed in v0.4 with user feedback

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.2 welcome redesign per user feedback "quá xấu" on v0.3.1; mascot + width-aware 2-col/stacked/compact/plain variants; inspired by Claude Code Clawd pattern; locked visual identity.
