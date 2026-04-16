---
id: SPEC-804
title: Slack channel adapter with Block Kit approval UI
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
  - src/channels/slack/adapter.ts
  - src/channels/slack/serde.ts
  - src/channels/slack/installer.ts
  - tests/channels/slack/adapter.test.ts
---

# Slack channel adapter with Block Kit approval UI

## 1. Outcomes

- Users send messages in a Slack workspace; nimbus replies in the same thread using Socket Mode (no public URL required).
- Only Slack user IDs matching `allowedUserIds` reach the agent; unknown IDs silently dropped + security event logged.
- Permission-gate approvals surface as Block Kit interactive messages with `Approve` / `Deny` buttons.
- OAuth install flow persists tokens via SPEC-152 vault; bot token never written to plaintext config.

## 2. Scope

### 2.1 In-scope
- `@slack/bolt` Socket Mode app — no public ingress required
- OAuth install flow: `installer.ts` handles `oauth/install` + `oauth/redirect`; stores `botToken` + `userToken` in vault
- OAuth state parameter: HMAC-SHA256(installSecret, nonce + expiresAt). Expires 5min. Verified on `/oauth/redirect`. Prevents CSRF bot-token hijack.
- `channelWorkspaceMapping: Record<string, string>` (Slack channel ID → workspaceId)
- `allowedUserIds: string[]` (Slack `U0…` format)
- Unknown userId → silent drop + `security.event` on EventBus
- Block Kit approval UI: `actions` block with `approve` / `deny` button values; `action_id` encodes `requestId`
- `serde.ts`: Slack `message` event → `ChannelInboundEvent`; agent reply text → Slack `mrkdwn`
- Rate limiter: Slack Tier-2 default 20 req/min per method; use SPEC-802 `RateLimiter` with 20 tok/60s
- HMAC-SHA256 request signature verify scaffolded but inactive (Socket Mode verifies internally; defer webhook path to v0.3.1)

### 2.2 Out-of-scope
- Webhook mode + HMAC verification → v0.3.1
- Slash commands (`/nimbus ...`) → v0.4
- Modals / home tab → v0.4
- Multi-workspace Slack tenancy → v0.5

## 3. Constraints

### Technical
- `@slack/bolt` ≥3.19 (Socket Mode stable, Bun-compatible)
- No `any` types; strict TypeScript
- Max 400 LoC per file; `adapter.ts` ≤250 LoC
- Bot token + signing secret NEVER logged; scrub via SPEC-601 `SENSITIVE_FIELDS`
- Socket Mode connection must reconnect automatically on disconnect (bolt handles this; config `socketMode: true, appToken`)

### Performance
- Message round-trip <500ms excluding LLM latency
- Block Kit render <50ms

### Resource / Business
- Requires Slack app with `chat:write`, `im:history`, `im:read` scopes + Socket Mode enabled
- App-level token (`xapp-…`) stored in vault separate from bot token

## 4. Prior Decisions

- **Socket Mode over incoming webhooks** — Socket Mode requires no public URL, matching nimbus-os local-first principle; webhooks require TLS ingress (deferred to v0.3.1)
- **`@slack/bolt` not raw Web API** — bolt handles reconnect, event acknowledgement, and rate-limit retries; rolling these manually would be ~500 extra LoC
- **Block Kit over plain text for approval** — Block Kit buttons give structured, accessible interaction; plain text with "reply Y/N" is fragile and error-prone
- **OAuth flow in `installer.ts`** — separating install from runtime adapter keeps `adapter.ts` under 400 LoC and makes the install path independently testable

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `serde.ts`: Slack event → ChannelInboundEvent + text → mrkdwn | Unit: mentions stripped, code spans converted, emoji pass-through | 60 | — |
| T_auth | HMAC state generation + verify (~20 LoC) | Unit: valid state accepted; tampered state rejected; expired (>5min) state rejected | 20 | — |
| T2 | `installer.ts`: OAuth install + token vault write + HMAC state verification | Unit (mocked vault): tokens stored under `slack.botToken` + `slack.appToken`; CSRF attempt with invalid state → 400 | 80 | T_auth |
| T3 | `adapter.ts`: bolt Socket Mode setup + allowedUserIds guard | Unit (mocked bolt): allowed userId → event published; unknown → security event | 110 | T1, T2 |
| T4 | Block Kit approval UI + action handler | Unit: `buildApprovalBlocks` includes `requestId`; action callback routes to approve/deny | 50 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `adapter.test.ts`:
  - Allowed userId → `channel.inbound` published
  - Unknown userId → `security.event` with `reason: 'unauthorized_slack_user'`; no `channel.inbound`
  - `stop()` → bolt app disconnects; queue drained
- `serde.test.ts`: `<@U123>` mention stripped; ` `` ` code → mrkdwn backtick; bold `*x*` preserved
- `installer.test.ts`: OAuth callback stores `botToken` in vault; second install overwrites cleanly

### 6.2 E2E Tests
- `tests/e2e/slack-loopback.test.ts`: requires `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` envs; skip if absent. Mock bolt event → adapter → mock agent reply → verify `postMessage` called.

### 6.3 Performance Budgets
- Serde per message <5ms
- Block Kit builder <50ms

### 6.4 Security Checks
- Bot token + app-level token sourced exclusively from vault
- `userId` validated against `^U[A-Z0-9]{8,}$` pattern before allowlist check
- Block Kit action payload decoded inside try/catch; malformed `action_id` → drop + warn log
- HMAC-SHA256 signing secret scaffolded in `installer.ts` for future webhook support (not yet wired)

## 7. Interfaces

```ts
export interface SlackAdapterConfig {
  allowedUserIds: string[]
  channelWorkspaceMapping: Record<string, string>   // Slack channelId → workspaceId
}

export function createSlackAdapter(cfg: SlackAdapterConfig): ChannelAdapter

// serde.ts
export function slackEventToInbound(event: SlackMessageEvent, workspaceId: string): ChannelInboundEvent
export function textToSlackMrkdwn(text: string): string

// installer.ts
export interface InstallResult {
  botToken: string
  appToken: string
  teamId: string
}
export function runOAuthInstall(code: string): Promise<InstallResult>
```

## 8. Files Touched

- `src/channels/slack/adapter.ts` (new, ~110 LoC)
- `src/channels/slack/serde.ts` (new, ~60 LoC)
- `src/channels/slack/installer.ts` (new, ~80 LoC)
- `tests/channels/slack/adapter.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Should install flow expose a `nimbus slack install` CLI sub-command or only a local HTTP callback? (decide before T2)
- [ ] Slack Tier-1 burst (100 req/min for `chat.postMessage`) — worth configuring separate rate limit class? (v0.3.1)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial for v0.3 sprint
- 2026-04-16 @hiepht: v0.3 reviewer amendment — add OAuth CSRF protection via HMAC-SHA256 state parameter (5min TTL, verified on redirect); add T_auth task (~20 LoC)
