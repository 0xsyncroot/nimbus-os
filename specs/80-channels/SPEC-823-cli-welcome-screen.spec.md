---
id: SPEC-823
title: CLI welcome screen with earth-brown theme
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: channels
depends_on: [SPEC-801, SPEC-822]
blocks: []
estimated_loc: 160
files_touched:
  - src/channels/cli/welcome.ts
  - src/channels/cli/colors.ts
  - src/channels/cli/repl.ts
  - src/core/workspace.ts
  - tests/channels/cli/welcome.test.ts
---

# CLI welcome screen with earth-brown theme

## 1. Outcomes

- First-run (or returning after >1h) users see a branded welcome with workspace name, active model, and usage tips — differentiated from Claude Code's neutral palette by an earth-brown (nâu đất) aesthetic.
- Quick re-launches (<1h since last boot) show a compact 2-line variant to avoid banner fatigue.
- Narrow terminals (cols<60), `NO_COLOR`, or non-TTY environments degrade to a plain `[OK]` fallback compatible with script parsing.
- All meaningful info is conveyed via text and shape — not color alone (a11y rule).

## 2. Scope

### 2.1 In-scope

- `renderWelcome()` public function + three variants: `full`, `compact`, `plain`
- Earth-brown palette constants (`EARTH_*`) in `colors.ts`, gated via existing `isColorEnabled()`
- `pickVariant()` selector based on `{ firstRun, lastBootAt, cols, noColor, isTTY, force }`
- Integration into `src/channels/cli/repl.ts` boot path — replace L199-200 single-line print with `renderWelcome(...)`
- Persistence of `lastBootAt` and `numStartups` fields in `workspace.json` (additive schema, no migration)
- `NIMBUS_FORCE_WELCOME=full|compact|plain` env flag for smoke-testing

### 2.2 Out-of-scope (defer to other specs)

- Animated boot, gradient sweep, figlet banner → deferred to v0.4+
- Theme customization / per-user banner override → deferred to v0.4+
- ANSI-art avatar or mascot → deferred to v0.4+

## 3. Constraints

### Technical

- No new npm deps — reuse ANSI helpers already in `colors.ts`
- Bun ≥1.2, TypeScript strict, no `any`
- Max 400 LoC per file; `welcome.ts` target ~90 LoC, `colors.ts` additions ~25 LoC
- Windows Terminal + conpty safe: no cursor-up escapes that double-paint

### Performance

- Render call <10ms p99 — no async I/O on welcome path (workspace meta already cached at call site)
- Output ≤15 terminal rows (full variant); ≤2 rows (compact variant)

### Resource / Business

- 1 dev part-time
- `stripAnsi(line).length ≤ cols` enforced per line in full + compact variants

## 4. Prior Decisions

- **Earth-brown palette, not cyan/blue** — nimbus brand differentiates from Claude Code's neutral Ink color system. Constants: `EARTH_DEEP=\x1b[38;5;94m`, `EARTH_LIGHT=\x1b[38;5;180m`, `EARTH_DIM=\x1b[38;5;58m`, `EARTH_GOLD=\x1b[38;5;136m`, `EARTH_BARK=\x1b[38;5;130m`. All resolve to empty string when `isColorEnabled()` returns false (covers `NO_COLOR` + `TERM=dumb`).
- **No Ink, no figlet, no gradient sweep** — Claude Code uses Ink (`WelcomeV2.tsx`) with a shaded mascot. nimbus REPL is readline-native; adding Ink means +2MB bundle and a full rewrite. Figlet becomes an annoyance on every launch. Gradient sweep flickers under conpty.
- **`░▒▓` block chars for subtle static gradient** — CP437/legacy-safe, 3-char static render. Same characters Claude Code's Clawd block uses. No sweep, no animation.
- **Variant selector on `{ firstRun, lastBootAt >3600s, cols<60, noColor, !isTTY }`** — mirrors Claude Code `LogoV2.tsx:118` variant-selection logic; compact on quick re-launch avoids banner fatigue.
- **`lastBootAt` + `numStartups` persisted in `workspace.json`** — additive schema fields, ~5 LoC in `workspace.ts`. No migration required (undefined fields treated as defaults).

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Extend `colors.ts` with `EARTH_*` constants gated via `isColorEnabled()` | 5 consts, all return `''` under `NO_COLOR` or `TERM=dumb` | 25 | — |
| T2 | `welcome.ts` — `pickVariant()` + `renderFull()` + `renderCompact()` + `renderPlain()` | Unit tests pass; each variant respects width + row limits | 90 | T1 |
| T3 | `workspace.ts` — persist `lastBootAt`, `numStartups` in `workspace.json` | Schema additive; round-trip read/write test passes | 10 | — |
| T4 | `repl.ts` — replace boot print (L199-200) with `renderWelcome(...)` + persist meta | Manual smoke: all 3 variants reachable via `NIMBUS_FORCE_WELCOME` | 10 | T2, T3 |
| T5 | `welcome.test.ts` — snapshot each variant, `NO_COLOR` strip, narrow fallback, width assertion | Snapshots stable; `stripAnsi(line).length ≤ cols` for every line | 25 | T2 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/welcome.test.ts`: `pickVariant()` returns `'full'`/`'compact'`/`'plain'` for input matrix (first-run, >1h, <1h, narrow, no-color, non-TTY)
- `renderPlain()` output starts with `[OK]`
- `renderCompact()` produces ≤2 lines, each fitting ≤80 cols after `stripAnsi`
- `renderFull()` produces ≤15 lines, each fitting ≤60 cols after `stripAnsi` (narrow-safe)
- `NIMBUS_FORCE_WELCOME` overrides `pickVariant()`

### 6.2 Regression Snapshots

- DEFAULT (80 cols, color, TTY, first-run) → `full`
- Narrow (59 cols) → `plain`
- `NO_COLOR=1` → `plain`
- `TERM=dumb` → `plain`

### 6.3 Performance Budgets

- `renderWelcome()` call <10ms warm via `bun:test` bench

### 6.4 Security Checks

- No user secrets or model keys rendered in welcome output
- `wsName` and `endpoint` values are display-only; not eval'd or logged

## 7. Interfaces

```ts
export interface WelcomeInput {
  wsName: string;
  model: string;
  providerKind: 'anthropic' | 'openai-compat';
  endpoint?: string;
  lastBootAt?: number;       // unix seconds
  numStartups?: number;
  memoryNoteCount?: number;
  cols: number;
  isTTY: boolean;
  noColor: boolean;
  force?: 'full' | 'compact' | 'plain';
}

export type WelcomeVariant = 'full' | 'compact' | 'plain';

export function pickVariant(input: WelcomeInput): WelcomeVariant;
export function renderWelcome(input: WelcomeInput): string;
```

Workspace meta additions (`src/core/workspace.ts`):

```ts
// Additive fields on WorkspaceMeta (no migration)
lastBootAt?: number;   // unix seconds, set on each REPL boot
numStartups?: number;  // monotonic counter, unbounded u32
```

## 8. Files Touched

- `src/channels/cli/welcome.ts` (new, ~90 LoC) — `pickVariant` + 3 render functions
- `src/channels/cli/colors.ts` (modified, +25 LoC) — `EARTH_*` palette constants
- `src/channels/cli/repl.ts` (modified, ~10 LoC) — replace L199-200 with `renderWelcome`
- `src/core/workspace.ts` (modified, ~10 LoC) — `lastBootAt` + `numStartups` fields + persist
- `tests/channels/cli/welcome.test.ts` (new, ~25 LoC) — snapshots + width assertions

## 9. Open Questions

- [ ] Should `numStartups` be capped (e.g., ≤9999) or unbounded? — current decision: unbounded u32; won't hit limit in practice. Revisit if workspace.json size ever audited.
- [ ] `NIMBUS_FORCE_WELCOME` env flag scope: dev-only or documented in `nimbus --help`? — current decision: undocumented dev/test escape hatch; not surfaced in user help text.

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 welcome screen + earth-brown palette. Based on comparison with Claude Code `LogoV2/WelcomeV2` pattern; plain ANSI (no Ink), readline-native REPL.
