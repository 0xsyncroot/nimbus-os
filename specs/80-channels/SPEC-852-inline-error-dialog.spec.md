---
id: SPEC-852
title: inline-error-dialog — Ink ErrorDialog replaces raw JSON errors
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, META-012]
blocks: []
estimated_loc: 120
files_touched:
  - src/channels/cli/ink/components/ErrorDialog.tsx
  - src/channels/cli/render.ts
  - src/channels/cli/slashCommands.ts
  - tests/channels/cli/ink/components/ErrorDialog.test.tsx
---

# inline-error-dialog — Ink ErrorDialog Replaces Raw JSON Errors

## 1. Outcomes

- Mid-turn errors and slash command errors render as a styled `<ErrorDialog>` box instead of raw `[ERROR] T_VALIDATION: {"reason":"bad_input"}` strings.
- Dialog uses `error` color token (ThemeProvider, SPEC-840), round border, localized message, and `ErrorCode` badge.
- Optional "run `nimbus doctor`" footer hint appears for system-level codes (`Y_*`, `X_*`).
- `NO_COLOR` degrades to plain text with `[ERROR]` prefix (no box-drawing characters).

## 2. Scope

### 2.1 In-scope
- New `src/channels/cli/ink/components/ErrorDialog.tsx` (~80 LoC).
- Replace `JSON.stringify(err.context)` in `render.ts` (mid-turn error path) and `slashCommands.ts:85-90` (slash command error path).
- i18n: messages looked up via `META-012` codes; fallback to `err.message` if code not in bundle.
- `NO_COLOR` support: detect `process.env.NO_COLOR` or `AppContext.noColor`; render plain text branch.
- Narrow terminal (cols<60): omit border, print `[error-code] message` on one line.

### 2.2 Out-of-scope (defer to other specs)
- Self-heal suggestions inside dialog → SPEC-602
- Full i18n locale policy → SPEC-854
- Modal error panels (full-screen takeover) → SPEC-847
- Toast / notification system → defer to v0.5

## 3. Constraints

### Technical
- Bun ≥1.2; Ink 7 + React 19.
- TypeScript strict, no `any`.
- Max 400 LoC per file. `ErrorDialog.tsx` target: ≤80 LoC.
- Must use `ThemeProvider` `error` color token from SPEC-840 (no hardcoded color strings).
- SPEC-833 layer rule: component MUST NOT import `tools/` or `providers/` directly.

### Performance
- `<ErrorDialog>` first paint ≤10ms (no async work).

## 4. Prior Decisions

- **Ink component, not console.error** — gap audit 1.19 identified raw `JSON.stringify(err.context)` leaking provider-internal state to users. A styled component can selectively show user-friendly fields vs full context.
- **Round border, not box** — visual distinction from `<Pane>` (rectangular) signals "this is a transient alert, not content". Matches Claude Code's `<Alert>` pattern.
- **`ErrorCode` badge always shown** — power users can grep logs; seeing `T_VALIDATION` is more actionable than a localized string alone.
- **Doctor hint for `Y_*` + `X_*` only** — tool errors (`T_*`) are transient; system/security errors suggest environment problems where `nimbus doctor` helps.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `<ErrorDialog>` component | Renders: round border, `error` token, title, code badge, hint; `NO_COLOR` branch; narrow branch | 80 | SPEC-840 T1 |
| T2 | Wire into `render.ts` | Mid-turn `NimbusError` renders `<ErrorDialog>` not raw JSON | 15 | T1 |
| T3 | Wire into `slashCommands.ts` | Lines 85-90 (slash error catch) render `<ErrorDialog>` | 10 | T1 |
| T4 | Unit tests | Renders expected text; `NO_COLOR`=plain; narrow=no border; doctor hint on Y_OOM; no doctor hint on T_VALIDATION | 40 | T1 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/ink/components/ErrorDialog.test.tsx` (ink-testing-library):
  - `T_VALIDATION` error: renders code badge `T_VALIDATION`, localized message, no doctor hint.
  - `Y_OOM` error: renders doctor hint `run nimbus doctor`.
  - `X_BASH_BLOCKED` error: renders doctor hint.
  - `NO_COLOR=1`: no box-drawing characters in output.
  - cols=50: no border, single-line format.

### 6.2 E2E Tests
- `tests/e2e/errorDialog.test.ts`: trigger a `T_VALIDATION` via a bad slash command argument; assert output contains code badge and does NOT contain `JSON.stringify` artifacts.

### 6.3 Security Checks
- `err.context` fields shown in dialog must be scrubbed of secrets: no `key`, `token`, `password` field values displayed (show `[redacted]`).
- Gap audit 1.19 regression: `grep -n "JSON.stringify(err" src/channels/cli/render.ts src/channels/cli/slashCommands.ts` = 0 after this spec.

## 7. Interfaces

```tsx
// src/channels/cli/ink/components/ErrorDialog.tsx

interface ErrorDialogProps {
  error: NimbusError;
  /** Passed from AppContext; triggers NO_COLOR branch */
  noColor?: boolean;
  /** Terminal columns; triggers narrow branch at <60 */
  cols?: number;
}

export function ErrorDialog({ error, noColor, cols }: ErrorDialogProps): React.ReactElement
```

```ts
// Usage in render.ts (conceptual)
if (event.type === 'agent.error') {
  ink.rerender(<ErrorDialog error={event.error} noColor={ctx.noColor} cols={ctx.cols} />)
}
```

## 8. Files Touched

- `src/channels/cli/ink/components/ErrorDialog.tsx` (new, ~80 LoC)
- `src/channels/cli/render.ts` (amend, ~+15 LoC, remove raw JSON.stringify)
- `src/channels/cli/slashCommands.ts` (amend, ~+10 LoC, lines 85-90)
- `tests/channels/cli/ink/components/ErrorDialog.test.tsx` (new, ~40 LoC)

## 9. Open Questions

- [ ] Show `err.context` in collapsed/expandable section for power-user debug mode? (defer to v0.4.1)
- [ ] Should `<ErrorDialog>` auto-dismiss after N seconds for non-blocking errors? (defer — current: stays until next render cycle)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — gap audit 1.19 identified raw JSON error leak; no spec existed for fix)
