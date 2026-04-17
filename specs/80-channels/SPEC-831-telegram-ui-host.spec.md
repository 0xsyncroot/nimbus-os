---
id: SPEC-831
title: Telegram UIHost — wire approval.ts through UIHost contract
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3
layer: channels
pillars: [P3, P5]
depends_on: [SPEC-830, SPEC-803, SPEC-808, SPEC-401]
blocks: []
estimated_loc: 220
files_touched:
  - src/channels/telegram/uiHost.ts
  - src/channels/telegram/approval.ts
  - src/channels/telegram/adapter.ts
  - src/channels/runtime.ts
  - src/core/loop.ts
  - tests/channels/telegram/uiHost.test.ts
  - tests/channels/telegram/approval.test.ts
---

# Telegram UIHost — wire approval.ts through UIHost contract

## 1. Outcomes

- Telegram user sees `inline_keyboard` [Approve] / [Deny] buttons when agent hits a permission-ask or `UIIntent.confirm` — currently broken (Expert 1 §V2, Expert 3 §3).
- `loopAdapter.onAsk` resolves with Telegram user's tap (not `undefined`) — dead code in `src/channels/telegram/approval.ts` is revived and wired.
- Reply lands in the origin chat (invariant per OpenClaw pattern, Expert 3 §2); `editMessageReplyMarkup` strips buttons after a tap so stale clicks no-op.
- Permission `ask` + `confirm` / `pick` intents all flow through the same `UIHost` — zero Telegram-specific branching in `core/loop.ts`.

## 2. Scope

### 2.1 In-scope
- `TelegramUIHost` implementing `UIHost` from SPEC-830
- Maps `UIIntent.confirm` → two-button `inline_keyboard` (Approve / Deny)
- Maps `UIIntent.pick` → N-button `inline_keyboard` paginated (max 8 options per message; adds `Next ▸` button when overflowing)
- Maps `UIIntent.input` → sends prompt, waits for next text message from `allowedUserId`
- Maps `UIIntent.status` → `sendMessage` with level-tagged prefix; returns `ok` immediately
- Correlation: uses `correlationId` from `UIContext` as Telegram `callback_data` payload token (base64url, max 64 bytes per Telegram limit)
- `editMessageReplyMarkup` to strip buttons after first valid tap → prevents double-resolve
- Registered into `ChannelRuntime` so `loopAdapter.onAsk` picks the Telegram host when the inbound event came from Telegram (routed by `UIContext.channelId`)
- Unit tests: callback_data round-trip, allowlist enforcement, button-strip idempotency

### 2.2 Out-of-scope (defer to other specs)
- Multi-workspace routing → v0.4 (already deferred in SPEC-808 §2.2)
- Photo / voice / document input intents → v0.4
- Webhook transport (still long-poll) → SPEC-803.1
- CLI UIHost → SPEC-832

## 3. Constraints

### Technical
- Depends on `node-telegram-bot-api` already in SPEC-808; no new deps
- Callback data ≤ 64 bytes (Telegram hard limit) — `correlationId` must be trimmed to ≤ 40 bytes before encoding
- Max 400 LoC per file; split across `uiHost.ts` + existing `approval.ts`

### Security
- Only `allowedUserIds` (SPEC-808 config) may resolve an intent; taps from other users → drop silently, log at `warn`
- `correlationId` is opaque to user; reject taps whose decoded id has no pending promise (prevents replay)
- Never embed chat text in `callback_data` (leaks, size limit) — use correlation map in memory
- Pending-intent map has 5-min TTL; expired → resolve with `timeout` and emit audit event

### Performance
- Button render + send <300ms p95 over polling loop
- Correlation map eviction O(1) via `Map` + timeout handle per entry

## 4. Prior Decisions

- **Use existing `approval.ts`, don't rewrite** — Expert 1 §V2 and Expert 3 §3 both flag it as 80% done; only wiring missing.
- **`inline_keyboard` over reply-keyboard** — OpenClaw pattern (Expert 3 §2); keeps chat clean, single-message affordance.
- **Strip buttons via `editMessageReplyMarkup`** — stale-click no-op matches user expectation; Expert 3 explicit recommendation.
- **Route via `UIContext.channelId`, not string-match** — avoids brittle `if (channel === 'telegram')` in core; contract is typed.
- **Correlation map in-memory, not persisted** — pending intents die with the REPL process (acceptable: v0.3 has no daemon yet, SPEC-808 §2.2).

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `TelegramUIHost` skeleton + intent dispatch | TSC green, intents map to methods | 70 | SPEC-830 T2 |
| T2 | `callback_data` encode/decode + pending map | Round-trip tests pass, 64-byte cap enforced | 50 | T1 |
| T3 | Wire into `ChannelRuntime` + `loopAdapter.onAsk` | Tap on Approve resolves `onAsk` with `{ decision: 'allow' }` e2e | 50 | T2 |
| T4 | `editMessageReplyMarkup` strip + replay reject | Second tap is dropped, audit logs "stale" | 30 | T3 |
| T5 | Tests (unit + smoke with stub bot) | `bun test tests/channels/telegram/` green | 80 | T4 |

## 6. Verification

### 6.1 Gate A — Reviewer
- reviewer-security: callback_data cannot inject; allowlist enforced before resolve; no secrets logged
- reviewer-architect: no `channels/telegram/` import from `core/` (only `core/ui` imported into telegram)

### 6.2 Gate B — Real Telegram bot smoke
- Fresh vault + fresh bot token → `nimbus` REPL, trigger a Bash `ask` → Telegram user taps Approve → tool executes → reply posts to same chat
- Second tap on same message → no-op, audit shows "stale correlation"
- Non-allowlist user taps → drop, debug log only

### 6.3 Gate C — CI
- `bun test tests/channels/telegram/` green on 3 OS
- `bun run typecheck` + `bun run spec validate` green

## 7. Interfaces

```ts
// src/channels/telegram/uiHost.ts
import type { UIHost, UIIntent, UIContext, UIResult } from '../../core/ui';

export function createTelegramUIHost(deps: {
  bot: TelegramBot;
  chatId: number;
  allowedUserIds: Set<number>;
  logger: Logger;
}): UIHost;

type PendingEntry<T> = {
  correlationId: string;
  intent: UIIntent;
  resolve: (r: UIResult<T>) => void;
  messageId: number;
  expiresAt: number;
};
```

## 8. Files Touched

- `src/channels/telegram/uiHost.ts` (new, ~120 LoC)
- `src/channels/telegram/approval.ts` (modify, revive + wire, ~30 LoC net)
- `src/channels/telegram/adapter.ts` (modify, expose `onCallbackQuery`, ~20 LoC)
- `src/channels/runtime.ts` (modify, register host, ~20 LoC)
- `src/core/loop.ts` (modify, call `uiHost.ask` via `onAsk`, ~30 LoC)
- `tests/channels/telegram/uiHost.test.ts` (new, ~80 LoC)
- `tests/channels/telegram/approval.test.ts` (modify, add wired path, ~40 LoC)

## 9. Open Questions

- [ ] Persist pending intents across REPL restart? (defer to v0.4 daemon SPEC-9xx)
- [ ] Emoji on buttons (✓ / ✗)? (Telegram renders fine; decide at review)

## 10. Changelog

- 2026-04-17 @hiepht: draft initial; supersedes SPEC-825 Telegram confirm approach
