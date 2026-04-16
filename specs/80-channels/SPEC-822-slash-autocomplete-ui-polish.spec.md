---
id: SPEC-822
title: Slash command autocomplete UI polish
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: channels
depends_on: [SPEC-801]
blocks: []
estimated_loc: 400
files_touched:
  - src/channels/cli/slashAutocomplete.ts
  - src/channels/cli/slashRenderer.ts
  - src/channels/cli/slashCommands.ts
  - src/channels/cli/colors.ts
  - tests/channels/cli/slashRenderer.test.ts
---

# Slash command autocomplete UI polish — Claude Code quality

## 1. Outcomes

- User perceives nimbus REPL as polished desktop-class CLI, not 1990s terminal
- ≥10ms/keystroke → sub-1ms render via partial redraw
- Discoverable args (arg card with examples on trailing space)
- No visual jitter: fixed-width columns, bounded height, centered scroll

## 2. Scope

### 2.1 In-scope

- **4 render states**: list (filter), arg-card (trailing space), empty-picker (just `/`), fallback (narrow/dumb term)
- **Accent + dim** color scheme (replace inverse video `\x1b[7m` with `\x1b[38;5;39m` + `▸` marker + dim unselected)
- **Category grouping**: extend `SlashCommand` with `category?: 'session'|'workspace'|'model'|'system'`; empty-picker groups by category
- **Arg hints**: extend `SlashCommand` with `argHint?: string` (e.g. `[name]`) + `argChoices?: string[]` for enum args (`/mode`, `/thinking`)
- **Ghost text**: first-match autocomplete after cursor, dim `\x1b[38;5;240m`, Tab accepts
- **Partial redraw**: store `lastRenderedLines[]`, only rewrite changed rows via `\x1b[{n}F` + `\x1b[2K`
- **Fixed-width name column** (40% of terminal width, capped at 20) with `truncateToWidth` on description
- **Keybind legend** below list (dim footer): `↑↓ select   tab complete   enter run   esc cancel`
- **Feature flag**: `NIMBUS_SLASH_UI=plain|polished`, default `polished`. Auto-fallback to plain when `!isTTY || TERM=dumb || cols<60`

### 2.2 Out-of-scope (v0.4+)

- Mouse support
- Fuzzy ranking (Fuse.js/nucleo) — keep prefix+alpha sort
- Per-user theme customization
- Ink runtime
- File path completion (`@` trigger) — separate spec later

## 3. Constraints

### Technical
- Bun-native, TS strict, no `any`
- No new deps — all box-drawing chars are default BMP (`▸ │ ─ ·`)
- Public API `createAutocomplete` + `Autocomplete` interface unchanged (only render fn swapped)
- Keep existing state machine + keyboard loop in `slashAutocomplete.ts`

### Performance
- Keystroke-to-paint <10ms p95 (target ~1ms)
- Partial redraw writes ≤ 1KB per keystroke

### Security
- No color-only information — selection also uses `▸` marker (a11y)
- Wide-char safety: cap description to ASCII-width on CJK input

### Cross-platform
- Windows Terminal + conpty: partial redraw must not double-paint (gate `\x1b[F` on feature-detect)
- iTerm2 + GNOME Terminal: smoke tested with visual snapshots

## 4. Prior Decisions

- **Accent over inverse video** — Claude Code uses `color="suggestion"` not invert; invert reads as "terminal-1990s"
- **No box border** — Claude Code flex-end anchors with single horizontal rule; box borders flicker and waste rows
- **Pure ANSI, no Ink** — Ink runtime adds ~2MB bundle + rewrites `render.ts` + `subscriptions.ts`; too invasive for UX polish
- **Category taxonomy 4 buckets** — session/workspace/model/system; matches mental model, no deep nesting
- **Arg card on trailing space** — clear affordance "what does this command take?"
- **Ghost text opt-in via Tab** — don't auto-complete on type, user controls

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | Extend `SlashCommand` with category + argHint + argChoices | all 13 existing commands backfilled | 50 | — |
| T2 | `slashRenderer.ts` — renderList + accent/dim color scheme | selected row uses `▸` + accent, unselected dim | 60 | T1 |
| T3 | `slashRenderer.ts` — renderArgCard (trailing space state) | `/model ` shows arg hint + examples | 40 | T1 |
| T4 | `slashRenderer.ts` — renderEmpty (just `/` state) | 4 categories grouped inline | 40 | T1 |
| T5 | `slashRenderer.ts` — renderGhost (autocomplete preview) | `\x1b[38;5;240m` ghost after cursor, Tab accept | 30 | T1 |
| T6 | `slashAutocomplete.ts` — partial redraw with diff | <1KB per keystroke, no double-paint | 40 | T2-T5 |
| T7 | `colors.ts` — ACCENT/DIM/GHOST/RULE constants | re-usable across slash + markdown renders | 10 | — |
| T8 | Fallback detection — `!isTTY \|\| cols<60 \|\| TERM=dumb` | old rendering preserved | 20 | T6 |
| T9 | Feature flag `NIMBUS_SLASH_UI` | `plain` forces old renderer | 15 | T6 |
| T10 | Tests + visual snapshots (.ansi.txt fixtures) | 12 snapshot tests across states | 120 | all |

## 6. Verification

### 6.1 Unit Tests
- renderList: filter 3 cmds → correct layout, accent on sel, dim on others
- renderArgCard: `/model ` → card with `[name]` + examples
- renderEmpty: categorize 13 cmds into 4 groups, each category label dim
- renderGhost: buffer `/mo` + filtered=[/model, /mode] → ghost `del` after cursor
- Partial redraw: 2 keystrokes → 2nd writes only changed rows (assert bytes < 1KB)

### 6.2 Visual snapshots
- `.ansi.txt` fixtures for each state × (narrow/wide terminal)
- Compare with `strip-ansi` + normalize

### 6.3 Cross-platform
- CI matrix: ubuntu, macos, windows — each runs snapshot test
- Manual smoke on Windows Terminal + iTerm2 + GNOME Terminal (QA checklist item)

### 6.4 Performance
- Bench: 100 keystrokes simulated, p95 < 10ms, total < 100ms

## 7. Interfaces

```ts
interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ReplContext) => Promise<void> | void;
  // NEW v0.3
  category?: 'session' | 'workspace' | 'model' | 'system';
  argHint?: string;        // e.g. '[name]', '[readonly|default|bypass]'
  argChoices?: string[];   // e.g. ['readonly', 'default', 'bypass']
  argExamples?: string[];  // e.g. ['gpt-5.4-mini', 'claude-sonnet-4-6']
}

type RenderState =
  | { kind: 'list'; filtered: SlashCommand[]; selected: number }
  | { kind: 'argCard'; cmd: SlashCommand }
  | { kind: 'empty'; byCategory: Map<string, SlashCommand[]> }
  | { kind: 'fallback'; filtered: SlashCommand[]; selected: number };

function renderList(state: RenderState, cols: number): string[];
function renderArgCard(cmd: SlashCommand, cols: number): string[];
function renderEmpty(cmds: SlashCommand[], cols: number): string[];
function renderGhost(cmd: SlashCommand, buffer: string, cols: number): string;

function diffAndWrite(
  prev: string[],
  next: string[],
  output: NodeJS.WritableStream,
): void;  // partial redraw via \x1b[nF + \x1b[2K
```

## 8. Files Touched

- `src/channels/cli/slashCommands.ts` (extend, ~50 LoC added)
- `src/channels/cli/slashRenderer.ts` (new, ~180 LoC)
- `src/channels/cli/slashAutocomplete.ts` (swap renderDropdown, ~40 LoC delta)
- `src/channels/cli/colors.ts` (constants, ~10 LoC)
- `tests/channels/cli/slashRenderer.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Wide-char CJK support in name column — accept v0.3 degrade to ASCII-width, proper wcwidth in v0.4?
- [ ] Should `/help` always be top of list regardless of filter? (probably yes — UX)

## 10. Changelog

- 2026-04-16 @hiepht: draft — Phase 1 analyst (Opus) report: 4 render states + 5 visual upgrades ported from Claude Code Ink pattern without Ink runtime.
