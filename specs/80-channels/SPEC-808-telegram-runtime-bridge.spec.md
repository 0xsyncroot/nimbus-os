---
id: SPEC-808
title: Telegram runtime bridge — tool + CLI + inbound loop
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: channels
depends_on: [SPEC-802, SPEC-803, SPEC-152, SPEC-301]
blocks: []
estimated_loc: 600
files_touched:
  - src/channels/runtime.ts
  - src/channels/telegram/config.ts
  - src/tools/builtin/Telegram.ts
  - src/cli/commands/telegram.ts
  - src/core/promptSections.ts
  - src/tools/defaults.ts
  - src/cli.ts
  - src/storage/workspaceStore.ts
  - tests/channels/runtime.test.ts
  - tests/channels/telegram/config.test.ts
  - tests/tools/telegram.test.ts
---

# Telegram runtime bridge — tool + CLI + inbound loop

## 1. Outcomes

- User in REPL can say "kết nối telegram" / "connect telegram" and the agent invokes `ConnectTelegram` tool; no hallucinated python bot written.
- When the adapter is running, any Telegram message from an allowed user is routed into a REAL turn on the nimbus agent loop; reply is sent back to the same chat.
- `nimbus telegram set-token` / `allow <id>` / `status` / `test` works from the shell as a scriptable path alongside the REPL flow.
- When user exits REPL the adapter cleanly stops (no dangling polling or process leak).

## 2. Scope

### 2.1 In-scope
- Singleton `ChannelRuntime` (one `ChannelManager` + inbound bridge per REPL process)
- Telegram config helpers that read/write `telegram.botToken`, `telegram.allowedUserIds`, `telegram.defaultWorkspaceId` from vault
- Three builtin tools: `ConnectTelegram`, `DisconnectTelegram`, `TelegramStatus`
- Inbound bridge: subscribe `TOPICS.channel.inbound` → run `runTurn` → send reply via adapter `sendToChat`
- `nimbus telegram` CLI subcommand (set-token / allow / list / status / test)
- Static prompt section `[CHANNELS]` that tells agent the built-in adapters exist — prevents the v0.3.5 hallucination
- TOOLS.md template note listing the Telegram tools

### 2.2 Out-of-scope (defer to other specs)
- Daemon / background service so bot runs when REPL closed → v0.4 (SPEC-9xx)
- Webhook transport → v0.3.1
- Photo / voice / document handling → v0.4
- Multi-workspace Telegram routing → v0.4
- Slack runtime bridge → separate spec (copy-paste same pattern post-Telegram ship)

## 3. Constraints

### Technical
- Bun ≥1.2, no Node-specific shims
- TypeScript strict, no `any`
- Max 400 LoC per file
- Vault token NEVER logged; mask via `redactSecret`
- Inbound bridge must NOT block REPL readline — runs inbound turns on the global event loop, serialised per chatId

### Performance
- `ConnectTelegram` tool: <2s to return OK (one `getMe` call + one bus subscribe)
- Inbound round-trip (Telegram message → agent reply sent): dominated by LLM latency; bridge overhead <100ms

### Resource / Business
- User creates bot via @BotFather, pastes token; no extra infra required
- Long-polling fair-use on Telegram free API

## 4. Prior Decisions

- **Tool-first over slash-first** — user said "kết nối tele" in natural language; agent must have a real tool to invoke, not a `/telegram` slash. `/telegram` would teach users an extra grammar we don't need; the agent can route.
- **Singleton runtime, not per-turn** — adapter needs to live across turns (polling is continuous); a per-turn lifecycle would thrash the bot.
- **In-REPL-only in v0.3.6** — daemon is a separate spec. Degrade gracefully: when user exits REPL, adapter stops; status command shows "offline" and hints to start REPL.
- **Config in vault, not workspace.json** — token is a secret; allowlist is linked to the bot token lifetime; putting both in the vault keeps auth material together and off disk plaintext.
- **`telegram.botToken` account uses non-provider prefix** — KeyManager uses `provider:<name>` accounts. Telegram token uses `service:telegram:botToken` to avoid colliding with provider discovery logic.
- **New prompt section `[CHANNELS]`** — tells agent the adapters exist and hints the exact tool names. Without this, agent grasps at Bash/Write and hallucinates a python bot.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `channels/telegram/config.ts` — getToken/setToken/allow/list/clear | Unit: roundtrip, mask on list, deny zero-length token | 80 | — |
| T2 | `channels/runtime.ts` — singleton channel runtime + inbound bridge | Unit: start/stop lifecycle idempotent; inbound event routes to fake runTurn | 140 | T1 |
| T3 | `tools/builtin/Telegram.ts` — three tools | Unit: ConnectTelegram fails with clear error when no token; succeeds when mocked; DisconnectTelegram idempotent; Status returns correct shape | 160 | T2 |
| T4 | Wire tools into `defaults.ts`; add `[CHANNELS]` to promptSections; append INJECTION_ORDER entry | Typecheck passes; tests for promptSections updated | 40 | T3 |
| T5 | `cli/commands/telegram.ts` + route in `cli.ts` | CLI smoke: `nimbus telegram status` works without REPL | 140 | T1 |
| T6 | TOOLS.md template note; keep under 400 LoC | Template mentions ConnectTelegram | 10 | T4 |
| T7 | Bind channel runtime into REPL so tool has access | REPL boot constructs runtime; tool handler pulls it from ctx or singleton | 30 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/telegram/config.test.ts`: token roundtrip; allowlist add/remove/list; reject empty; mask on list
- `tests/channels/runtime.test.ts`: start/stop idempotency; inbound event → fakeRunTurn called; adapter send called with reply text; unknown adapterId → no-op
- `tests/tools/telegram.test.ts`: ConnectTelegram returns `ok:false` with `U_MISSING_CONFIG` when no token; succeeds with mocked adapter; Status returns {connected, botUsername?, allowedUsers[]}

### 6.2 E2E / Smoke
- Compiled binary: `nimbus telegram status` without prior setup → "offline" message, exit 0
- Compiled binary: `nimbus telegram set-token` (via `--token-stdin`) + `allow 12345` + `status` → reports one user
- REPL smoke (manual with real bot token if provided by user): `kết nối telegram` → agent calls ConnectTelegram → adapter comes online → send Telegram message → agent replies in Telegram

### 6.3 Performance Budgets
- ConnectTelegram handler: one `getMe` call + subscribe + start; <2s

### 6.4 Security Checks
- Token read from vault only; never written to stdout, logs, tool_result, or system prompt
- Tool `display` field uses bot `username` not token
- Bridge subscriber callback wraps inbound text with `<tool_output trusted="false">` (already handled in serde)
- Silent-drop for non-allowlisted senders preserved (adapter already does this; bridge must not override)

## 7. Interfaces

```ts
// channels/telegram/config.ts
export async function getTelegramBotToken(wsId?: string): Promise<string | null>;
export async function setTelegramBotToken(token: string, wsId?: string): Promise<void>;
export async function getAllowedUserIds(wsId?: string): Promise<number[]>;
export async function addAllowedUserId(userId: number, wsId?: string): Promise<void>;
export async function removeAllowedUserId(userId: number, wsId?: string): Promise<void>;
export async function clearTelegramConfig(wsId?: string): Promise<void>;
export interface TelegramStatus {
  tokenPresent: boolean;
  botUsername?: string;
  allowedUserIds: number[];
}

// channels/runtime.ts
export interface ChannelRuntime {
  manager: ChannelManager;
  startTelegram(opts: { wsId: string; model: string; providerKind: 'anthropic' | 'openai-compat'; endpoint?: string; baseUrl?: string }): Promise<{ botUsername: string }>;
  stopTelegram(): Promise<void>;
  isTelegramRunning(): boolean;
  dispose(): Promise<void>;
}
export function getChannelRuntime(): ChannelRuntime;

// tools/builtin/Telegram.ts
export function createConnectTelegramTool(): Tool;
export function createDisconnectTelegramTool(): Tool;
export function createTelegramStatusTool(): Tool;
```

## 8. Files Touched

- `src/channels/telegram/config.ts` (new, ~80 LoC)
- `src/channels/runtime.ts` (new, ~180 LoC)
- `src/tools/builtin/Telegram.ts` (new, ~180 LoC)
- `src/cli/commands/telegram.ts` (new, ~150 LoC)
- `src/core/promptSections.ts` (edit — add `CHANNELS_SECTION`, update `INJECTION_ORDER`)
- `src/core/prompts.ts` (edit — inject CHANNELS_SECTION)
- `src/tools/defaults.ts` (edit — register 3 new tools)
- `src/cli.ts` (edit — route `telegram` subcommand + version bump)
- `src/storage/workspaceStore.ts` (optional edit — TOOLS.md template update)
- `tests/channels/runtime.test.ts` (new, ~120 LoC)
- `tests/channels/telegram/config.test.ts` (new, ~80 LoC)
- `tests/tools/telegram.test.ts` (new, ~100 LoC)

## 9. Open Questions

- [ ] Should ConnectTelegram prompt for token if missing (interactive)? → No — tools must be non-interactive; failing with a clear `U_MISSING_CONFIG + hint` is honest.
- [ ] Default workspace resolution when multiple workspaces exist → v0.3.6 uses `active` workspace; multi-ws mapping deferred to v0.4.

## 10. Changelog

- 2026-04-16 @hiepht: draft + self-approve for urgent v0.3.6-alpha fix (v0.3.5 shipped with dead-code adapter; user caught hallucination)
