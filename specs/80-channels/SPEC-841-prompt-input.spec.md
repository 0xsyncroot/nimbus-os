---
id: SPEC-841
title: Multi-line PromptInput with paste preservation
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, SPEC-850]
blocks: []
estimated_loc: 500
files_touched:
  - src/channels/cli/ink/components/PromptInput.tsx
  - src/channels/cli/ink/components/PromptInput/useInputBuffer.ts
  - src/channels/cli/ink/components/PromptInput/useHistory.ts
  - src/channels/cli/ink/components/PromptInput/usePasteHandler.ts
  - src/channels/cli/ink/components/PromptInput/inputModes.ts
  - src/channels/cli/ink/components/PasswordPrompt.tsx
  - tests/channels/cli/ink/prompt-input.test.ts
---

# Multi-line PromptInput with Paste Preservation

## 1. Outcomes

- User can type multi-line input; up/down arrows navigate within buffer lines before switching to history at boundary.
- Paste of N-line content preserves all newlines; large pastes (≥5 lines) create a `[Pasted text N lines #id]` reference token.
- Mode prefixes (`/`, `@`, `!`, `#`) at position 0 are detected and surfaced to the parent app via `onModeChange`.
- Ctrl-C stashes draft (`stashedPrompt`) and restores it on next turn; password prompts mask via `@inkjs/ui PasswordInput`.

## 2. Scope

### 2.1 In-scope
- Custom multi-line input on ink `useInput` + `usePaste` (ink#921).
- Char buffer + cursor state in `useInputBuffer`; history in `useHistory`.
- Paste handling in `usePasteHandler`; large-paste reference token generation.
- Mode sigil detection at pos 0 in `inputModes.ts` (`getModeFromInput`, `getValueFromInput`).
- Password mode wrapping `@inkjs/ui PasswordInput`; Ctrl-L emits `app:redraw`; Ctrl-C stashes draft.
- Vietnamese multi-byte correctness via `string-width`.
- MIGRATE `src/onboard/keyPrompt.ts` via SPEC-850 `keyPromptCore` extraction; do NOT delete the file (7+ call sites pre-Ink). Deletion is gated on SPEC-850 landing and all call sites migrated.

### 2.2 Out-of-scope
- Slash autocomplete dropdown → SPEC-842.
- Alt-screen modal interactions → SPEC-847.
- Kitty keyboard protocol opt-in → SPEC-849.
- Mouse click-to-position → deferred to v0.5.

## 3. Constraints

### Technical
- Bun ≥1.3.5, TypeScript strict, no `any`, max 400 LoC per file.
- Use `string-width` for all cursor-advance calculations (emoji, CJK, Vietnamese diacritics).
- Ink #759 (IME/CJK drop) unresolved upstream — PTY smoke MUST exercise `chào anh em` paste.
- Ink #660, #676 (multi-line gaps) — this component fills the gap; budget for edge-case fixes.
- `@inkjs/ui PasswordInput` is MANDATORY for all key/secret prompts. No new path may bypass it (CLAUDE.md §10 HARD RULE).
- `usePaste` from ink#921 is required; do NOT implement raw stdin byte scanning for paste detection.

### Security
- Paste in password mode applies mask BEFORE render; raw clipboard bytes are never written to stdout. The `usePaste` payload feeds directly into the masked buffer without touching any output stream.

### Performance
- Keypress → re-render ≤16ms (one frame at 60 Hz).
- Paste of 500 lines must not block render thread; stash to `stashedPrompt` async if needed.
- `LARGE_PASTE_THRESHOLD_BYTES = 10_000` — paste exceeding this size is immediately tokenized to `[Pasted N lines #id]`; the full content is stored in a side buffer and is never re-fed to `string-width` per keystroke.
- Cursor-width is cached per visible line; cache is invalidated on line edit to prevent stale width calculations.

### Resource / Business
- 1 dev part-time. ~500 LoC net.

## 4. Prior Decisions

- **Custom multi-line, not `@inkjs/ui TextInput`** — `TextInput` is single-line; ink#660 + #676 open. We fill the gap with a custom hook stack. (META-011 §4)
- **`usePaste` for paste detection** — raw stdin scanning breaks IME; ink#921 gives a clean paste event hook.
- **`string-width` for cursor math** — `str.length` breaks on multi-byte chars; pattern from Claude Code `PromptInput.tsx:194`.
- **`stashedPrompt` draft preservation** — matches Claude Code behavior; prevents content loss on Ctrl-C.
- **`PasswordInput` mandatory** — `keyPrompt.ts` leaks plaintext when env var pre-set (gap audit 3.9); this spec closes that hole.
- **Claude Code refs**: `PromptInput.tsx:194-2338`, `inputPaste.ts`, `useArrowKeyHistory.ts`, `usePromptInputPlaceholder.ts:25-76`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `useInputBuffer` hook | Cursor advances correctly for ASCII, CJK, emoji; Backspace removes grapheme cluster | 80 | — |
| T2 | `useHistory` hook | Up at line 0 cycles history; Down at last line cycles forward; no cycle when buffer has multiple lines except at boundary | 40 | T1 |
| T3 | `usePasteHandler` hook | Paste preserves newlines; ≥5 lines → reference token; calls `onPaste` callback | 60 | T1 |
| T4 | `inputModes.ts` | `getModeFromInput('/')` returns `'slash'`; all 4 sigils detected; non-sigil returns `'text'` | 30 | — |
| T5 | `PromptInput.tsx` | Renders buffer + cursor, wires all hooks, emits `onSubmit`/`onCancel`/`onModeChange` | 220 | T1-T4 |
| T6 | `PasswordPrompt.tsx` | Wraps `@inkjs/ui PasswordInput`; char echoes as `*`; `onSubmit` fires on Enter | 40 | — |
| T7 | Migrate `keyPrompt.ts` call sites | No import of `keyPrompt` remains in `src/onboard/`, `src/key/`, `src/cli/commands/`; callers migrated to SPEC-850 `keyPromptCore` or `PasswordPrompt` (gated on SPEC-850 landing) | 0 | T6 |
| T8 | Tests | Unit tests for all hooks + component; PTY smoke for Vietnamese paste | 180 | T1-T7 |
| T9 | T9 landmine migration audit | `grep -rn "rl\.question\|createInterface" src/onboard src/key src/cli/commands` returns 0 for secret material; all `createInterface`/`rl.question` call sites in `src/onboard/init.ts` (lines 99-103, 82-87) + `src/key/**` + `src/cli/commands/**` that carry API key / base URL / passphrase material route through SPEC-850 `keyPromptCore` or Ink `PasswordPrompt` | 0 | T7 |
| T10 | Platform keys | `alt+v` for image-paste on `process.platform === 'win32'`; `ctrl+v` elsewhere. `shift+tab` mode cycle everywhere; `meta+m` fallback on Windows where `shift+tab` is ambiguous | 20 | T5 |
| T11 | Placeholder rotation | `usePromptInputPlaceholder` hook with priority `teammate > queue (max 3×) > example`; rotates every 8s | 30 | T5 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/prompt-input.test.ts`: buffer insert/delete/cursor, history cycle, paste, mode detection, stash-restore, password masking.
- `describe('SPEC-841: PromptInput', ...)` wrapper.

### 6.2 PTY Smoke (Gate B prerequisite)
- Spawn binary in PTY (cols:80, rows:24 via `Bun.spawn({terminal})`).
- Type `chào anh em` char-by-char; assert width matches `string-width` expectation.
- Paste `"line1\nline2\nline3"` → 3-line render, no truncation.
- Ctrl-C mid-edit → stash preserved; next prompt → draft restored.
- Password prompt: each keypress echoes `*`, actual value never visible.

### 6.3 Performance Budgets
- Keypress → re-render ≤16ms (measured via `ink-testing-library` timing).
- No render blocking for paste ≤500 lines.

### 6.4 Security Checks
- `PasswordPrompt` uses `@inkjs/ui PasswordInput` exclusively.
- No plaintext key echoing in any terminal output stream.
- `keyPrompt.ts` deleted; `grep -r keyPrompt src/` returns 0 matches post-migration.

## 7. Interfaces

```ts
export type InputMode = 'text' | 'slash' | 'file-ref' | 'bash' | 'memory';

export interface PromptInputProps {
  placeholder?: string;
  stashedPrompt?: string;
  onSubmit: (value: string, mode: InputMode) => void;
  onCancel: () => void;
  onModeChange?: (mode: InputMode) => void;
  onStash?: (draft: string) => void;
  multiLine?: boolean; // default true
}

export interface PasswordPromptProps {
  label: string;
  onSubmit: (secret: string) => void;
}

// inputModes.ts
export function getModeFromInput(raw: string): InputMode;
export function getValueFromInput(raw: string): string; // strips leading sigil
```

## 8. Files Touched

- `src/channels/cli/ink/components/PromptInput.tsx` (new, ~220 LoC)
- `src/channels/cli/ink/components/PromptInput/useInputBuffer.ts` (new, ~80 LoC)
- `src/channels/cli/ink/components/PromptInput/useHistory.ts` (new, ~40 LoC)
- `src/channels/cli/ink/components/PromptInput/usePasteHandler.ts` (new, ~60 LoC)
- `src/channels/cli/ink/components/PromptInput/inputModes.ts` (new, ~30 LoC)
- `src/channels/cli/ink/components/PasswordPrompt.tsx` (new, ~40 LoC)
- `tests/channels/cli/ink/prompt-input.test.ts` (new, ~180 LoC)
- `src/onboard/keyPrompt.ts` (MIGRATE via SPEC-850; do not delete until all 7+ call sites have been migrated)

## 9. Open Questions

- [ ] Shift+Enter vs meta+Enter for newline insert — confirm UX with user before impl.
- [ ] Large-paste threshold: 5 lines or configurable? (default 5, defer config to v0.5)

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-streaming.
- 2026-04-17 @hiepht: detail-pass — reversed keyPrompt.ts delete (MIGRATE via SPEC-850, 7+ call sites); added T9 landmine migration acceptance grep; added Security §paste mask-before-render; pinned LARGE_PASTE_THRESHOLD_BYTES=10_000 + cursor-width cache policy; added T10 platform keys (alt+v/ctrl+v, shift+tab/meta+m); added T11 usePromptInputPlaceholder hook; added SPEC-850 to depends_on
