---
id: SPEC-806r
title: Narrow event fanout — notify-me when CLI closed
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: channels
pillars: [P1, P9]
depends_on: [SPEC-118, SPEC-803, SPEC-134]
blocks: []
estimated_loc: 150
files_touched:
  - src/channels/fanout/narrowHub.ts
  - src/channels/fanout/telegramNotify.ts
  - tests/channels/fanout/narrowHub.test.ts
---

# Narrow Event Fanout — Notify-me When CLI Closed

## 1. Outcomes

- When the daemon is running but the CLI REPL is closed, important events (cron-completed tasks, long-running bash finished, user-mentioned keywords) fan out to registered channels — primarily Telegram — as passive notifications.
- Addresses Expert A's observation that "CLI owns runtime → Telegram is vestigial when REPL closed" — daemon-mode (v0.4+) + narrow fanout makes the agent *actually* 24/7.
- Explicitly narrower than the killed-scope SPEC-806 gateway: no multi-consumer replay, no event cursor, no generic bus-as-a-service. One-way notify only.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Subscribe selector (notable-event filter) | Whitelist ~8 event types; all else ignored | 40 | SPEC-118 |
| T2 | Telegram notify sender (dedupe 10s window) | No duplicate pings; rate-limited | 60 | SPEC-803 |
| T3 | Config key `channels.notify.telegram.chatId` + on/off toggle | Default OFF; wizard in SPEC-901 later | 30 | SPEC-501 |
| T4 | Test: daemon-closed-CLI scenario end-to-end | Spawn daemon, close REPL, trigger cron job → Telegram receives message | 20 | SPEC-134 |
