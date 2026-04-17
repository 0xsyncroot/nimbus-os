---
id: SPEC-842
title: Slash autocomplete dropdown and /help overlay
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840]
blocks: []
estimated_loc: 300
files_touched:
  - src/channels/cli/ink/components/SlashAutocomplete.tsx
  - src/channels/cli/ink/components/HelpOverlay.tsx
  - src/channels/cli/ink/components/FileRefAutocomplete.tsx
  - tests/channels/cli/ink/autocomplete.test.ts
---

# Slash Autocomplete Dropdown and /help Overlay

## 1. Outcomes

- Typing `/` in the prompt opens a dropdown with slash commands grouped by category (session / workspace / mode / cost / memory); Tab accepts, Esc dismisses, Up/Down navigate.
- `/help` or `?` keybinding opens a full-screen 3-tab overlay (Commands, General, Keybindings).
- `@file ` prefix triggers file-ref autocomplete with fuzzy match against workspace file tree.
- Legacy `src/channels/cli/slashAutocomplete.ts` (519 LoC) and `slashRenderer.ts` are deleted; feature fully replaced by Ink components.

## 2. Scope

### 2.1 In-scope

- `SlashAutocomplete.tsx` — dropdown overlay, category grouping, keyboard nav (Tab/Esc/Up/Down/Enter), rendered as sibling subtree to `PromptInput` (Claude Code `PromptInputHelpMenu.tsx` pattern).
- `HelpOverlay.tsx` — full-screen overlay with `<Tabs>` from `@inkjs/ui`; 3 tabs: Commands, General, Keybindings; mirrors Claude Code `HelpV2.tsx:20-183`.
- `FileRefAutocomplete.tsx` — fuzzy match on `@file ` prefix; workspace `Glob` scan limited to 200 results.
- `autocomplete.test.ts` — renders, nav events, tab-accept, esc-dismiss, `/help` toggle, `?` synonym, file-ref fuzzy.
- DELETE `src/channels/cli/slashAutocomplete.ts` (after migration).
- DELETE `src/channels/cli/slashRenderer.ts` (after migration).

### 2.2 Out-of-scope

- `PromptInput` multi-line widget (host component) → SPEC-841 (must land first in practice).
- Keybinding manager context stack → SPEC-849.
- Modal alt-screen for `/model`, `/cost`, `/memory` overlays → SPEC-847.
- `@mention` autocomplete for agent names → deferred to v0.5.

## 3. Constraints

### Technical

- Depends on SPEC-840 (theme tokens, `<Tabs>`, `ThemedText`). Cannot run without it.
- `PromptInput` (SPEC-841) is the practical host; until SPEC-841 lands, components are unit-tested in isolation via `ink-testing-library`.
- Match algorithm mirrors Claude Code `utils/suggestions/commandSuggestions.ts` — prefix-first, then fuzzy substring.
- Keybindings: Tab=accept, Esc=dismiss, Up/Down=navigate (Claude Code `defaultBindings.ts:100-107`).
- `?` must be reservable as `/help` synonym; actual binding registered in keybinding manager (SPEC-849).
- Layer rule (SPEC-833): no import from `tools/`.
- Max 400 LoC per file.

### Performance

- Dropdown open-to-render <16ms (one frame budget).
- File-ref scan capped at 200 results; async with `Glob` scan, debounced 80ms.

## 4. Prior Decisions

- **Sibling subtree pattern, not portal.** Claude Code renders `PromptInputHelpMenu` as a sibling `<Box>` below the input, not a React portal. Ink has no portal concept; same approach used here.
- **Delete `slashAutocomplete.ts` (519 LoC), not extend.** The file mixes rendering + match logic in raw readline mode. Ink components separate concerns cleanly; migration is cleaner than adapting.
- **`@inkjs/ui <Tabs>` for /help overlay.** Already a dep from SPEC-840; avoids building a tab widget from scratch. Claude Code's `HelpV2.tsx` structure is the UI reference.
- **`?` as `/help` synonym.** Claude Code reserves `?` as a keybinding alias (verified in `defaultBindings.ts`). SPEC-849 owns the registry; SPEC-842 only documents the intent.
- **Reference**: Claude Code `src/` — `PromptInputHelpMenu.tsx`, `PromptInputFooterSuggestions.tsx`, `HelpV2.tsx:20-183`, `utils/suggestions/commandSuggestions.ts`, `defaultBindings.ts:100-107`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `SlashAutocomplete.tsx` — dropdown + category groups + keyboard nav | Up/Down moves cursor, Tab accepts, Esc clears; `ink-testing-library` asserts frame output | 120 | SPEC-840 |
| T2 | `HelpOverlay.tsx` — 3-tab full-screen overlay | `/help` renders 3 tabs; tab-switch works; Esc closes; Commands list non-empty | 100 | T1 |
| T3 | `FileRefAutocomplete.tsx` — fuzzy file-ref | `@file path/to` narrows list; max 200 results; Tab accepts | 60 | SPEC-840 |
| T4 | `autocomplete.test.ts` — full suite | All nav, accept, dismiss, `/help`, `?` synonym, file-ref assertions green | 150 | T1, T2, T3 |
| T5 | Delete legacy files | `slashAutocomplete.ts` + `slashRenderer.ts` removed; no dead imports remain | -519 net | T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/autocomplete.test.ts`: dropdown renders with category groups; Tab accepts; Esc dismisses; `/help` opens 3-tab overlay; `?` maps to help; `@file ` triggers file-ref with fuzzy match; 200-result cap enforced.

### 6.2 Integration

- When SPEC-841 (`PromptInput`) lands, re-run tests with real host; confirm no stdin bleed.

### 6.3 Regression

- `src/channels/cli/slashAutocomplete.ts` deleted — verify no other file imports it (`bun run typecheck` green).

### 6.4 CI

- `bun test tests/channels/cli/ink/` green on 3 OS.
- `bun run typecheck` green.
- `bun run lint` no layer violations.

## 7. Interfaces

```ts
// SlashAutocomplete.tsx
interface SlashAutocompleteProps {
  query: string;
  onAccept: (command: string) => void;
  onDismiss: () => void;
}
export function SlashAutocomplete(props: SlashAutocompleteProps): React.ReactElement

// HelpOverlay.tsx
interface HelpOverlayProps {
  onClose: () => void;
}
export function HelpOverlay(props: HelpOverlayProps): React.ReactElement

// FileRefAutocomplete.tsx
interface FileRefAutocompleteProps {
  prefix: string;
  workspaceRoot: string;
  onAccept: (path: string) => void;
  onDismiss: () => void;
}
export function FileRefAutocomplete(props: FileRefAutocompleteProps): React.ReactElement
```

## 8. Files Touched

- `src/channels/cli/ink/components/SlashAutocomplete.tsx` (new, ~120 LoC)
- `src/channels/cli/ink/components/HelpOverlay.tsx` (new, ~100 LoC)
- `src/channels/cli/ink/components/FileRefAutocomplete.tsx` (new, ~60 LoC)
- `tests/channels/cli/ink/autocomplete.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Should category ordering in the dropdown be user-configurable or hardcoded? (defer to v0.5)
- [ ] File-ref autocomplete: include hidden files (`.env`, `.gitignore`)? (security risk — default exclude, confirm with user)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-foundation; synthesized from META-011 + Claude Code HelpV2 + commandSuggestions research
