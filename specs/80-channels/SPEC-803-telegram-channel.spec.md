---
id: SPEC-803
title: Telegram channel adapter with approval UI
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: channels
depends_on: [SPEC-802, SPEC-152, SPEC-501]
blocks: []
estimated_loc: 300
files_touched:
  - src/channels/telegram/adapter.ts
  - src/channels/telegram/serde.ts
  - src/channels/telegram/approval.ts
  - tests/channels/telegram/adapter.test.ts
---

# Telegram channel adapter with approval UI

## 1. Outcomes

- Users send messages to nimbus via Telegram bot; agent replies are delivered back to the same chat.
- Only Telegram user IDs in `allowedUserIds` config reach the agent; unknown IDs are silently dropped with a security event logged.
- Permission-gate approvals surface as inline-keyboard buttons (`Approve` / `Deny`) directly in Telegram chat.
- Rate limits enforced: 30 msg/sec global, 1 msg/sec per chat — never triggers Telegram 429 errors.

## 2. Scope

### 2.1 In-scope
- grammY long-polling (v0.3); webhook flag scaffolded but inactive
- Bot token loaded from SPEC-152 vault under key `telegram.botToken`
- `allowedUserIds: number[]` + `workspaceMapping: Record<number, string>` from workspace config (SPEC-501)
- Unknown `userId` → silent drop + publish `security.event` to EventBus with `{reason: 'unauthorized_telegram_user', userId}`
- Inline keyboard approval UI (`approval.ts`): pending `PermissionRequest` serialised to callback data, TTL 5 min
- `serde.ts`: convert grammY `Message` → `ChannelInboundEvent`; convert agent reply text → Telegram HTML
- Rate limiter: global 30 tok/s + per-chat 1 tok/s using SPEC-802 `RateLimiter`
- Outbound queue per-chat using SPEC-802 `OutboundQueue`

### 2.2 Out-of-scope
- Webhook mode → v0.3.1 (requires public TLS endpoint)
- Voice/photo/document handling → v0.4
- Multi-bot support → v0.4
- Group chat support → v0.4 (current: private chats only)

## 3. Constraints

### Technical
- grammY ≥1.26 (Bun-compatible, no Node-specific shims needed)
- No `any` types; strict TypeScript
- Max 400 LoC per file; `adapter.ts` must stay ≤250 LoC
- Bot token NEVER logged; scrub via SPEC-601 `SENSITIVE_FIELDS`
- Long-polling loop must stop cleanly on `stop()` (no dangling promises)

### Performance
- Message round-trip (user → agent receive) <500ms excluding LLM latency
- Inline keyboard render <100ms

### Resource / Business
- Requires Telegram bot token (user must create bot via @BotFather)
- No additional cloud cost (grammY long-polls Telegram API, included in free tier)

## 4. Prior Decisions

- **grammY over node-telegram-bot-api** — grammY has first-class TypeScript types, active maintenance, and documented Bun support
- **Long-polling not webhook for v0.3** — long-polling requires zero network ingress config; webhook needs a public URL + TLS, deferred to v0.3.1
- **Silent drop for unknown users** — active reply (e.g., "you are not authorised") leaks bot existence; silent drop + security log is the safer default
- **Approval via inline keyboard** — Telegram inline keyboards provide a native, mobile-friendly confirm/deny UX without requiring a separate web page
- **Per-chat outbound queue** — prevents one slow chat from blocking another; simplifies ordering guarantees

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `serde.ts`: Message → ChannelInboundEvent + text → HTML | Unit: emoji, bold, code blocks round-trip correctly | 60 | — |
| T2 | `approval.ts`: inline keyboard builder + callback parser | Unit: callback data encodes/decodes `{requestId, decision}` within 64-byte Telegram limit | 70 | — |
| T3 | `adapter.ts`: grammY setup + allowedUserIds guard | Unit (mocked grammY): allowed user → event published; unknown user → security event | 120 | T1, T2 |
| T4 | Rate limiter wiring (global + per-chat) | Integration: 35 rapid sends → 5 delayed ≥1s; no 429 from mock | 50 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `adapter.test.ts`:
  - Allowed userId → `channel.inbound` published to EventBus
  - Unknown userId → no `channel.inbound`; `security.event` published with `reason: 'unauthorized_telegram_user'`
  - `stop()` → long-polling stopped, queue drained within 2s
- `serde.test.ts`: Markdown bold `**x**` → `<b>x</b>`; code block → `<pre>`; special chars escaped
- `approval.test.ts`: callback payload ≤64 bytes; `parseCallbackData` round-trips `requestId`

### 6.2 E2E Tests
- `tests/e2e/telegram-loopback.test.ts`: mock grammY client sends message → adapter publishes event → mock agent reply → adapter calls `sendMessage` (requires `TELEGRAM_BOT_TOKEN` env, skip if absent)

### 6.3 Performance Budgets
- Message deserialisation (serde) <5ms per message

### 6.4 Security Checks
- Bot token sourced exclusively from vault (SPEC-152); never from env or plaintext config
- `userId` validated as positive integer before allowlist check
- Callback data decoded with `JSON.parse` inside try/catch; malformed payload → drop + warn log
- Security event for unknown user contains `userId` but NOT message content

## 7. Interfaces

```ts
export interface TelegramAdapterConfig {
  botToken: string              // loaded from vault, not stored in config file
  allowedUserIds: number[]
  workspaceMapping: Record<number, string>   // telegramUserId → workspaceId
  webhookMode?: false           // future: true enables webhook (v0.3.1)
}

export function createTelegramAdapter(cfg: TelegramAdapterConfig): ChannelAdapter

// serde.ts
export function telegramMsgToEvent(msg: Message, workspaceId: string): ChannelInboundEvent
export function textToTelegramHtml(text: string): string

// approval.ts
export interface ApprovalKeyboard {
  inlineKeyboard: InlineKeyboardButton[][]
}
export function buildApprovalKeyboard(requestId: string): ApprovalKeyboard
export function parseApprovalCallback(data: string): { requestId: string; approved: boolean } | null
```

## 8. Files Touched

- `src/channels/telegram/adapter.ts` (new, ~120 LoC)
- `src/channels/telegram/serde.ts` (new, ~60 LoC)
- `src/channels/telegram/approval.ts` (new, ~70 LoC)
- `tests/channels/telegram/adapter.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Should `workspaceMapping` fallback to a default workspace when a userId has no explicit mapping? (decide before impl)
- [ ] Webhook support design (TLS termination, secret token header) → v0.3.1 spec

## 10. Changelog

- 2026-04-16 @hiepht: draft initial for v0.3 sprint
