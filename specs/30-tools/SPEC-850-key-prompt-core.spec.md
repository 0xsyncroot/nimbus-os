---
id: SPEC-850
title: keyPromptCore — non-Ink pre-Ink key input pathway
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: onboard
depends_on: [META-011, SPEC-151]
blocks: [SPEC-855]
estimated_loc: 80
files_touched:
  - src/platform/keyPromptCore.ts
  - src/onboard/keyPrompt.ts
  - tests/platform/keyPromptCore.test.ts
---

# keyPromptCore — Non-Ink Pre-Ink Key Input Pathway

## 1. Outcomes

- All 7+ `rl.question`/`createInterface` call sites for secret material are replaced by a single hardened core function.
- API key input is always masked (asterisks) when stdin is a TTY — no plaintext echo regression.
- Ink `<PasswordPrompt>` (SPEC-841) imports this core module rather than duplicating masking logic.
- `src/onboard/keyPrompt.ts` becomes a thin re-export wrapper (~20 LoC), preserving existing callers.

## 2. Scope

### 2.1 In-scope
- New `src/platform/keyPromptCore.ts` (~60 LoC) exporting `readKeyFromStdin()` and `promptApiKey()`.
- Masking logic: TTY detection, per-char `*` echo, `\x7F` backspace removes last char from buffer.
- Paste preservation: multi-char paste burst treated as sequential chars, no data loss.
- Refactor `src/onboard/keyPrompt.ts` to re-export from core (keep public API stable).
- Unit tests covering TTY + non-TTY, backspace, paste burst, empty input rejection.

### 2.2 Out-of-scope (defer to other specs)
- Ink `<PasswordPrompt>` TSX component → SPEC-841
- Full onboarding wizard rewrite → SPEC-855
- OS keychain integration → SPEC-152

## 3. Constraints

### Technical
- Bun ≥1.2; use `node:readline` (Bun re-exports natively).
- TypeScript strict mode, no `any`.
- Max 400 LoC per file.
- No class inheritance — functional module.

### Security
- MUST mask when `process.stdin.isTTY === true`; if not TTY (pipe/CI), read without masking.
- `\x7F` (DEL/backspace) removes last char from internal buffer AND overwrites last `*` on screen.
- Buffer cleared from memory on return (assign `''` before returning).
- NEVER log the returned secret value via pino or any other channel.
- Caller sites outside this core MUST NOT do their own `rl.question` for secret material — enforced via grep check in CI acceptance.

### Performance
- `readKeyFromStdin()` adds ≤5ms overhead vs direct readline on TTY.

## 4. Prior Decisions

- **Core module in `platform/`, not `onboard/`** — platform layer owns OS-level I/O primitives; onboard is a consumer. Keeps the pure-TS import boundary clean.
- **Re-export wrapper instead of delete** — SPEC-841's predecessor (SPEC-841 draft) proposed deleting `keyPrompt.ts`; reversed here. Existing callers (`src/cli.ts`, `src/cli/commands/telegram.ts`, `src/cli/commands/key.ts`, `src/key/cli.ts`, `src/key/interactive.ts`, `src/cli/debug/vault.ts`) import from `onboard/keyPrompt`; changing all import sites in one PR risks churn. Wrapper costs 20 LoC, eliminates churn.
- **No `chalk`/ANSI helper dep** — write raw `\x08 \x08` (backspace-space-backspace) sequence directly; avoids extra dep for a 3-byte sequence.
- **Paste burst = sequential** — `readline` already serializes paste events through its own buffer; no special burst detection needed.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Implement `readKeyFromStdin(prompt: string): Promise<string>` | Returns input; masks on TTY; backspace works; empty string rejected with re-prompt | 45 | — |
| T2 | Implement `promptApiKey(label?: string): Promise<string>` | Calls `readKeyFromStdin` with label; validates non-empty; returns trimmed value | 15 | T1 |
| T3 | Refactor `src/onboard/keyPrompt.ts` as re-export | `import { promptApiKey } from '../platform/keyPromptCore'`; all existing callers unaffected | 20 | T1, T2 |
| T4 | Unit tests | TTY + non-TTY paths; backspace removes; paste preserved; empty rejected; secret not in logs | 60 | T1, T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/platform/keyPromptCore.test.ts`:
  - `readKeyFromStdin` with mocked TTY stdin: verify `*` characters written, not plaintext.
  - Backspace sequence: buffer `['a','b',DEL]` → result `'a'`.
  - Paste burst: `'sk-abc'` arrives as one write → full string returned.
  - Empty input: re-prompts (or throws `NimbusError(U_MISSING_CONFIG)`).
  - Non-TTY stdin (pipe): reads without masking.

### 6.2 E2E / Integration
- Acceptance grep: `grep -rn "rl\.question" src/ | grep -v keyPromptCore` must return 0 lines for secret-related call sites.
- SPEC-901 `nimbus init` smoke: key entry masked in PTY (Gate B PTY smoke SPEC-851-adjacent).

### 6.3 Security Checks
- Secret never logged: `grep -rn "logger.*key\|pino.*key" src/platform/keyPromptCore.ts` = 0.
- Buffer cleared: last line of `readKeyFromStdin` zeros the local buffer variable.

## 7. Interfaces

```ts
// src/platform/keyPromptCore.ts

/**
 * Read a secret string from stdin with per-char masking on TTY.
 * Handles backspace (\x7F) and paste bursts transparently.
 */
export function readKeyFromStdin(prompt: string): Promise<string>

/**
 * Prompt user for an API key (non-empty, trimmed).
 * Throws NimbusError(U_MISSING_CONFIG) if user provides empty string twice.
 */
export function promptApiKey(label?: string): Promise<string>
```

```ts
// src/onboard/keyPrompt.ts (after refactor — thin re-export)
export { readKeyFromStdin, promptApiKey } from '../platform/keyPromptCore'
```

## 8. Files Touched

- `src/platform/keyPromptCore.ts` (new, ~60 LoC)
- `src/onboard/keyPrompt.ts` (refactor → re-export wrapper, ~20 LoC)
- `tests/platform/keyPromptCore.test.ts` (new, ~60 LoC)

## 9. Open Questions

- [ ] Should `readKeyFromStdin` accept a max-length guard to prevent runaway paste? (defer to v0.4.1)
- [ ] Non-TTY CI: should `promptApiKey` auto-fail fast if stdin is not TTY and no value piped? (decide during impl)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — reverses SPEC-841 delete proposal, extracts core)
