---
id: META-012
title: UI error codes extension — U_UI_BUSY through P_OPERATION_DENIED
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: meta
depends_on: [META-003]
blocks: [SPEC-852]
estimated_loc: 40
files_touched:
  - src/observability/errors.ts
  - src/i18n/messages/en.ts
  - src/i18n/messages/vi.ts
  - tests/observability/errors.test.ts
---

# UI Error Codes Extension

## 1. Purpose

Add four UI-layer `ErrorCode` enum values — `U_UI_BUSY`, `U_UI_CANCELLED`, `P_KEYBIND_RESERVED`, `P_OPERATION_DENIED` — to `src/observability/errors.ts`. Extends META-003 without modifying existing codes. Enables `SPEC-852` `<ErrorDialog>` and `SPEC-849` keybinding manager to throw typed codes with localized messages and correct `classify()` severity.

## 2. Scope

### 2.1 In-scope
- Add 4 new `ErrorCode` values to `src/observability/errors.ts`.
- Define `isRetryable()` and `isUserFacing()` behavior for each new code.
- Add localized message copy in `src/i18n/messages/en.ts` and `src/i18n/messages/vi.ts`.
- Unit test: `classify()` maps each new code correctly; severity matrix entry per code.

### 2.2 Out-of-scope (defer to other specs)
- `<ErrorDialog>` component → SPEC-852
- Full i18n locale policy → SPEC-854
- Keybinding manager throwing `P_KEYBIND_RESERVED` → SPEC-849

## 3. Constraints

### Technical
- Extend `ErrorCode` enum non-destructively (existing codes unchanged — stable string keys per META-003 §5).
- TypeScript strict, no `any`.
- Localized strings: key format `error.<CODE>.title` and `error.<CODE>.hint` (consistent with existing i18n key shape).

### Resource / Business
- No new files; amend existing `errors.ts` only.

## 4. Prior Decisions

- **`U_UI_BUSY` code prefix `U_`** — it is a user-perceivable state (UI is occupied, cannot accept new input), not a provider-level error. Consistent with `U_BAD_COMMAND`, `U_MISSING_CONFIG`.
- **`U_UI_CANCELLED`** — separate from `T_TIMEOUT` (which covers tool/API timeouts). UI cancellation (user pressed Esc mid-flow) has distinct self-heal policy: no retry, just discard pending operation cleanly.
- **`P_KEYBIND_RESERVED`** — prefix `P_` (platform/permission) because it's a hard constraint set by the keybinding manager context system (SPEC-849), not a user mistake. Retryable = false; user-facing = true with hint.
- **`P_OPERATION_DENIED`** — catch-all for UI permission denials that don't fit `T_PERMISSION` (which is tool-gate). Example: user tries to open a modal when alt-screen is already active.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Add 4 codes to `ErrorCode` enum | Enum compiles; existing tests still pass | 8 | — |
| T2 | Update `isRetryable()` + `isUserFacing()` switch cases | `U_UI_BUSY` retryable=false, userFacing=true; `U_UI_CANCELLED` retryable=false, userFacing=false; `P_KEYBIND_RESERVED` retryable=false, userFacing=true; `P_OPERATION_DENIED` retryable=false, userFacing=true | 12 | T1 |
| T3 | Add i18n strings (en + vi) | Each code has `.title` + `.hint` keys; vi strings reviewed for natural phrasing | 16 | T1 |
| T4 | Unit tests | `classify()` round-trip for each new code; severity matrix assertions | 20 | T1, T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/observability/errors.test.ts`:
  - `new NimbusError(ErrorCode.U_UI_BUSY, {})` — `isUserFacing()` = true, `isRetryable()` = false.
  - `new NimbusError(ErrorCode.U_UI_CANCELLED, {})` — `isUserFacing()` = false.
  - `new NimbusError(ErrorCode.P_KEYBIND_RESERVED, { key: 'ctrl+c' })` — `isUserFacing()` = true, message includes key hint.
  - `new NimbusError(ErrorCode.P_OPERATION_DENIED, { reason: 'alt_screen_active' })` — `isUserFacing()` = true.

### 6.2 Integration
- `SPEC-852` `<ErrorDialog>` renders localized strings from these codes without fallback "unknown error".
- `SPEC-849` keybinding manager throws `P_KEYBIND_RESERVED` when a chord conflicts with a reserved binding.

## 7. Interfaces

```ts
// Additions to ErrorCode enum in src/observability/errors.ts

export enum ErrorCode {
  // ... existing codes unchanged ...

  // UI (U* — user-perceivable UI state errors)
  U_UI_BUSY            = 'U_UI_BUSY',        // UI occupied, cannot accept input
  U_UI_CANCELLED       = 'U_UI_CANCELLED',   // User cancelled a pending UI operation

  // Platform / Permission (P* additions)
  P_KEYBIND_RESERVED   = 'P_KEYBIND_RESERVED',  // Chord conflicts with reserved binding
  P_OPERATION_DENIED   = 'P_OPERATION_DENIED',  // UI permission denied (alt-screen, modal, etc.)
}
```

```ts
// i18n key shape (en bundle excerpt)
{
  "error.U_UI_BUSY.title": "UI is busy",
  "error.U_UI_BUSY.hint": "Wait for the current operation to complete.",
  "error.U_UI_CANCELLED.title": "Operation cancelled",
  "error.U_UI_CANCELLED.hint": "",
  "error.P_KEYBIND_RESERVED.title": "Key binding reserved",
  "error.P_KEYBIND_RESERVED.hint": "The key {{key}} is reserved by nimbus. Choose a different binding.",
  "error.P_OPERATION_DENIED.title": "Operation not allowed",
  "error.P_OPERATION_DENIED.hint": "{{reason}}"
}
```

## 8. Files Touched

- `src/observability/errors.ts` (amend, ~+20 LoC)
- `src/i18n/messages/en.ts` (amend, ~+8 LoC)
- `src/i18n/messages/vi.ts` (amend, ~+8 LoC)
- `tests/observability/errors.test.ts` (amend, ~+20 LoC)

## 9. Consumers

- `SPEC-852` — `<ErrorDialog>` renders localized strings for `U_UI_BUSY`, `P_KEYBIND_RESERVED`, `P_OPERATION_DENIED`.
- `SPEC-849` — keybinding manager throws `P_KEYBIND_RESERVED` on reserved-chord conflicts.
- `src/observability/errorFormat.ts` — formats all four codes for CLI stderr output.
- Any UI component needing to signal "operation in progress" should use `U_UI_BUSY`; cancellation flows use `U_UI_CANCELLED`.

## 10. Evolution Policy

- Existing codes (`U_UI_BUSY`, `U_UI_CANCELLED`, `P_KEYBIND_RESERVED`, `P_OPERATION_DENIED`) are **stable** — string keys must not change after v0.4.0-alpha (downstream consumers hard-code them per META-003 §5).
- To add new UI error codes: extend this spec and submit a new row in the task breakdown. Do not add codes directly to `errors.ts` without a spec update.
- If `isRetryable` or `isUserFacing` semantics need to change for these codes, update this spec's §5 acceptance criteria in the same commit.

## 11. Open Questions

- [ ] Should `U_UI_BUSY` be retryable with backoff in future? (current: no; defer to v0.4.1 if use-case emerges)
- [ ] Add `U_*` family to self-heal policy matrix in META-003? (yes — add note in META-003 §2.3 in same commit)

## 12. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — `U_UI_BUSY` existed in SPEC-832 impl but no spec; 3 other codes identified by reviewer-architect)
