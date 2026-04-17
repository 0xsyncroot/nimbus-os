---
id: SPEC-309
title: Telegram ChannelService port — eager CLI wiring
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.1
layer: channels
depends_on: [SPEC-808, SPEC-833]
blocks: []
estimated_loc: 20
files_touched:
  - src/channels/cli/repl.ts
  - tests/tools/telegram.test.ts
---

# Telegram ChannelService port — eager CLI wiring

## 1. Outcomes

- `TelegramStatus` tool invoked from CLI REPL returns real status (not the "channel service not available" stub).
- `ConnectTelegram` / `DisconnectTelegram` reach the registered port the first time they run in a fresh CLI session.
- Telegram-channel path unchanged; port still registered on first `getChannelRuntime()` call.

## 2. Scope

### 2.1 In-scope
- Call `getChannelRuntime()` once during CLI REPL bootstrap so `registerChannelService()` fires eagerly.
- Regression test: `TelegramStatus` handler against a freshly-constructed runtime (no mock) returns `{ connected:false, tokenPresent:false }` not the fallback stub.

### 2.2 Out-of-scope
- Option C (lazy vault-backed read without runtime) — deferred; current runtime already reads vault summary synchronously, so the port covers both stopped and running states.
- Changing `ConnectTelegram` deps-bridge model (already fine).

## 3. Constraints

### Technical
- No new `tools → channels` import; fix lives in `channels/cli/repl.ts` (composition root).
- META-001 DAG unchanged. SPEC-833 eslint rules still green.
- No `any`. Max 400 LoC per file. Net delta ~15 LoC src + ~40 LoC test.

### Security
- No vault/passphrase writes. `createRuntime()` is a pure factory until `startTelegram()` is called.

## 4. Prior Decisions

- **Eager init over lazy getter in tool** — Tool layer depending on the port keeps SPEC-833 clean. Adding a lazy `getChannelRuntime()` call from the tool would re-introduce a `tools → channels` edge.
- **Composition root does wiring** — the REPL is already the place that sets `setTelegramRuntimeBridge(...)`; the sibling `getChannelRuntime()` call belongs next to it.
- **No new port method** — `getTelegramStatus()` already reads the vault summary (`readSummary`) so it works while the adapter is stopped; no need for a separate `core/telegramService.ts`.

## 5. Task Breakdown

| ID | Task | Acceptance | LoC | Deps |
|----|------|------------|-----|------|
| T1 | Call `getChannelRuntime()` at REPL startup next to `setTelegramRuntimeBridge` | `getChannelService()` returns non-null during first tool call | 5 | — |
| T2 | Regression test: fresh runtime → `TelegramStatus` returns real status, not fallback | `display` !== `Telegram: channel service not available …` | 40 | T1 |

## 6. Verification

### 6.1 Unit Tests
- `tests/tools/telegram.test.ts`: new test "TelegramStatus returns real status after getChannelRuntime() bootstrap" — constructs the real runtime (not mock), asserts `connected:false`, `tokenPresent:false`, `allowedUserIds:[]`, and display does not contain the fallback string.

### 6.2 E2E / Smoke
- Manual PTY smoke after rebuild: start REPL, invoke agent turn that calls `TelegramStatus`, verify `display` reads `Telegram: offline (no token stored)` or similar.

### 6.3 Security Checks
- No new call site that touches `.vault-key` / `secrets.enc`.

## 7. Interfaces

No interface change. `ChannelService` port unchanged.

## 8. Files Touched

- `src/channels/cli/repl.ts` (edit, +1 line non-comment)
- `tests/tools/telegram.test.ts` (edit, +~40 LoC new describe block)

## 9. Open Questions

- [ ] Should we add a lint rule to fail if a `registerX()` port is declared but never invoked in composition roots? Defer — needs broader design.

## 10. Changelog

- 2026-04-17 @hiepht: draft + approved (one-line fix, regression test added).
