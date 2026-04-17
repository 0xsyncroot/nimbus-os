---
id: SPEC-904
title: Interactive key manager — /key slash + nimbus key menu
status: approved
version: 0.1.1
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3.9
layer: onboard
pillars: [P1, P6]
depends_on: [SPEC-152, SPEC-153, SPEC-902, META-009]
blocks: [SPEC-505]
estimated_loc: 200
files_touched:
  - src/key/interactive.ts
  - src/cli.ts
  - src/channels/cli/slashCommands.ts
  - tests/key/interactive.test.ts
  - tests/channels/cli/slashKey.test.ts
---

# Interactive key manager — `/key` slash + `nimbus key` menu

## 1. Outcomes

- User stuck with a bad API key can fix it in ≤30 seconds from either REPL (`/key`) or shell (`nimbus key`) without memorizing `key set --provider openai sk-...`.
- Single shared module serves THREE entry points (init first-write, interactive rotate, boot recovery per SPEC-505) — no duplicated masking/probe/validation logic.
- Replacing one provider's key leaves the other providers' keys untouched. No more "oops, `vault reset` wiped everything" footgun.
- Every write path funnels through `canDecryptVault` probe-before-write (HARD RULE compliance).

## 2. Scope

### 2.1 In-scope
- New module `src/key/interactive.ts` exporting `runInteractiveKeyManager()` — menu loop that lists configured providers (masked) + actions Replace / Test / Remove / Add new.
- `nimbus key` (no args) dispatches to `runInteractiveKeyManager()`.
- `/key` slash command registered in `src/channels/cli/slashCommands.ts`, returns user to REPL after the sub-flow completes.
- Masking format: `sk-****abcd` (first 3 + last 4 only; never full key at any UI stage).
- Live test: ping provider's cheapest model endpoint with a 1-token request before writing. On failure, show redacted error + offer retry or abort (do not persist bad key).
- Update of workspace.defaultProvider when the replaced key belongs to the currently-active provider (normalized to `kind` only — see project memory).

### 2.2 Out-of-scope (defer)
- Bulk-rotate (all keys at once) → v0.5 if requested.
- Keyboard shortcut scheme beyond arrows + digit select → v0.4 polish.
- Import/export of key sets → never (security risk).

## 3. Constraints

### Technical
- Must reuse `autoProvisionPassphrase` from `fileFallback.ts` — do NOT introduce a new passphrase derivation site.
- Every write MUST call `canDecryptVault` first; on fail, refuse write + raise `X_CRED_ACCESS / vault_locked` with recovery hint pointing to SPEC-505 flow.
- TTY detection: if `!process.stdin.isTTY`, refuse interactive menu and print the exact shell command equivalent (`nimbus key set --provider X`). No silent fallback.
- Max file LoC 400; interactive.ts target ~180 LoC.

### Performance
- Menu render <50 ms cold.
- Live-test call: respect a 10 s hard timeout; show "provider slow, try again?" not a stack trace.

### Resource / Business
- No network calls except the 1-token live-test (which is opt-in via `[T]est` action; `[R]eplace` optionally includes it).
- Works on all 3 OS; uses `node:readline` (Bun-native re-export).

## 4. Prior Decisions

- **Shared module, not 3 copies** — init, interactive, recovery all need the same masked-prompt + probe + write semantics. Forking them caused the v0.3.6 incident.
- **`nimbus key` with no args = interactive, not help** — `nimbus key --help` still shows help. No-args = "what would a user want?" → edit keys.
- **Surgical replace, not nuke+rebuild** — users tried `vault reset` when they meant "rotate openai key" and lost anthropic+gemini. Menu's default action is Replace, not Remove.
- **Live-test before write** — catches typos, revoked keys, region mismatches at the cheapest possible moment (before persistence).
- **`/key` is a slash, not a tool** — tools go through permission gate + audit; slash commands are UI primitives. Key management is UI.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Scaffold `src/key/interactive.ts` — menu loop skeleton | TTY check, list providers, masked display | 50 | — |
| T2 | Replace action (probe → prompt → live-test → write) | Funnels through `canDecryptVault` + `saveData` from SPEC-153 | 60 | T1 |
| T3 | Test / Remove / Add actions | Remove deletes only the selected provider key; Add validates new provider kind | 40 | T1 |
| T4 | Wire `nimbus key` no-arg to interactive | Existing `nimbus key set/remove/list` still work | 15 | T2 |
| T5 | Register `/key` slash command | REPL captures input, dispatches, returns control | 20 | T2 |
| T6 | Unit + E2E tests | See §6 | 60 | T3, T4, T5 |

## 6. Verification

### 6.1 Unit Tests
- `tests/key/interactive.test.ts`:
  - masks keys correctly (exact regex `/^.{3}\*{4}.{4}$/`)
  - refuses write if probe fails → emits `X_CRED_ACCESS`
  - live-test failure aborts write, vault unchanged
  - non-TTY refuses + prints shell equivalent
  - replacing key for provider A does NOT touch keys for B, C

### 6.2 E2E Tests
- `tests/e2e/key-interactive.test.ts` (PTY harness):
  - `nimbus key` → select openai → Replace → paste key → live-test pass → confirm → reopen REPL → chat works with new key
  - Pre-existing anthropic key still decryptable after the openai rotation (CRITICAL regression)
  - `/key` inside REPL → same flow, returns to REPL prompt after done

### 6.3 Performance Budgets
- First menu paint <50 ms.
- Live-test 10 s timeout hard-enforced.

### 6.4 Security Checks
- No key plaintext in logs (grep pino output for `sk-` fragments).
- NimbusError context uses masked form only.
- reviewer-security sign-off REQUIRED (touches credential write path).
- Upgrade regression: pre-populate vault with two providers under v0.3.8 layout → run interactive flow on v0.3.9 → assert zero key loss.

## 7. Interfaces

```ts
export interface KeyMenuOptions {
  readonly tty: boolean;
  readonly onExit?: () => void;
}

export async function runInteractiveKeyManager(
  opts: KeyMenuOptions,
): Promise<{ readonly changed: boolean; readonly provider?: string }>;

// slash registration
slashCommands.register({
  name: 'key',
  description: 'Manage API keys interactively',
  handler: () => runInteractiveKeyManager({ tty: true }),
});
```

## 8. Files Touched

- `src/key/interactive.ts` (new, ~180 LoC)
- `src/key/cli.ts` (edit, ~15 LoC — dispatch no-arg to interactive)
- `src/channels/cli/slashCommands.ts` (edit, ~10 LoC — register `/key`)
- `tests/key/interactive.test.ts` (new, ~120 LoC)
- `tests/e2e/key-interactive.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should Live-test be mandatory or optional on Replace? — Propose mandatory by default, with `--skip-test` escape hatch for `key set` only (never for interactive).
- [ ] Should remove require typed confirmation ("yes I want to remove openai")? — Propose YES for final action.

## 10. Changelog

- 2026-04-17 @hiepht: draft (v0.3.9 — unifies init/rotate/recovery flows into one module; prevents vault-reset-as-rotate footgun)
