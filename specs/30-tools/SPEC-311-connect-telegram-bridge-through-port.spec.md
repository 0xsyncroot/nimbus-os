---
id: SPEC-311
title: ConnectTelegram — bridge deps through ChannelService port
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.1
layer: tools
depends_on: [SPEC-309, SPEC-808, SPEC-833]
blocks: []
estimated_loc: 40
files_touched:
  - src/core/channelPorts.ts
  - src/channels/runtime.ts
  - src/tools/builtin/Telegram.ts
  - tests/tools/telegram.test.ts
---

# ConnectTelegram — bridge deps through ChannelService port

## 1. Outcomes

- `ConnectTelegram` invoked from the CLI REPL actually starts the Telegram
  adapter (long-poll up, `@username` returned) instead of failing with
  `U_MISSING_CONFIG / channel_runtime_bridge_required`.
- Port surface stays layer-clean: `src/core/` still has zero type edges to
  `src/tools/` or `src/channels/` (META-001 §2.2, SPEC-833 eslint green).
- Existing read-only flows (`TelegramStatus`, idempotent `DisconnectTelegram`,
  already-running short-circuit) unchanged.

## 2. Scope

### 2.1 In-scope
- Widen `ChannelService.startTelegram(wsId, deps?)` to take an opaque `deps: unknown`.
- Concrete runtime in `src/channels/runtime.ts` casts `deps` back to the
  informal `StartTelegramOptions` shape and delegates to
  `runtime.startTelegram({ wsId, ...deps })`.
- `ConnectTelegram` tool passes its `runtimeBridge(ctx)` result through the
  port as the opaque deps.
- Regression test: `ConnectTelegram` from the CLI channel with a deps-capable
  bridge starts the adapter and returns `{ botUsername, alreadyRunning:false }`.
- Regression test: `ConnectTelegram` without deps surfaces the typed
  `channel_runtime_not_wired` or `channel_runtime_deps_unavailable` error
  (no generic `channel_runtime_bridge_required` leaks to the user).

### 2.2 Out-of-scope
- Multi-process bot-token conflict handling (daemon IPC) — deferred to v0.4 (§ Option C).
- Option B (punt to separate `nimbus telegram` command) — rejected; the REPL
  is already the canonical composition root for Telegram in v0.3.
- Port type coupling to `Provider` / `Gate` / `ToolRegistry` — rejected;
  would break SPEC-833 core→tools lint rule.

## 3. Constraints

### Technical
- META-001 §2.2 DAG unchanged. ESLint `import/no-restricted-paths` still passes.
- No `any`. `deps: unknown` at the port boundary is the sanctioned opacity.
- Max 400 LoC per file. Net delta ~20 src + ~60 test.

### Security
- HARD RULE §10 — no vault/passphrase writes on any new path. `runtime.startTelegram`
  only READS `getTelegramBotToken` + `getAllowedUserIds` from the vault; fails
  fast with `U_MISSING_CONFIG` if either is missing.
- Bot token never logs in plaintext — existing `fetchBotUsername` handles auth
  via `Authorization` header-equivalent URL; pino logger already redacts.

### Performance
- Cold start: one `getMe` round-trip to Telegram API (~150ms). No new allocs.

## 4. Prior Decisions

- **Opaque deps over typed port** — typing the port with `Provider/Gate/ToolRegistry`
  would require `src/core/channelPorts.ts` to import from `src/tools/` and
  `src/permissions/`, violating SPEC-833 layer enforcement. `unknown` at the
  boundary + structural cast at the runtime is the minimum-surface contract.
- **Delegate to runtime.startTelegram, not duplicate** — the runtime already
  owns token/allowlist validation, adapter construction, manager registration,
  inbound bus subscription. Port closure reuses it.
- **Keep tool-side runtimeBridge** — it provides friendly typed errors
  (`channel_runtime_not_wired`, `channel_runtime_deps_unavailable`) that fire
  BEFORE the port call, so users outside a REPL get clear guidance.
- **No Option B (punt to CLI verb)** — `ConnectTelegram` is an AGENT tool;
  routing it to `nimbus telegram connect` would break the agent's action
  surface and diverge from the Slack/Discord path that will land in v0.2.
- **No Option C (daemon IPC)** — v0.4 dependency.

## 5. Task Breakdown

| ID | Task | Acceptance | LoC | Deps |
|----|------|------------|-----|------|
| T1 | Widen `ChannelService.startTelegram` signature to `(wsId, deps?: unknown)` | Port compiles; existing tests green | 3 | — |
| T2 | In `runtime.ts` port impl, consume deps + delegate to `runtime.startTelegram()` | Running adapter after port call | 12 | T1 |
| T3 | In `Telegram.ts`, pass `runtimeBridge(ctx)` as the second arg | ConnectTelegram from CLI succeeds | 3 | T2 |
| T4 | Regression test: mock ChannelService captures deps arg; ConnectTelegram passes it | Asserts deps flowed through port | 35 | T3 |
| T5 | Regression test: without bridge the tool surfaces typed error, not generic fallback | `reason === 'channel_runtime_not_wired'` | 15 | T3 |

## 6. Verification

### 6.1 Unit Tests

- `tests/tools/telegram.test.ts`: new test "SPEC-311: ConnectTelegram with deps
  reaches port.startTelegram(wsId, deps)". A mock `ChannelService` records the
  `deps` argument; assert it is the object returned by `runtimeBridge(ctx)`
  and that `result.ok === true` with the expected `botUsername`.
- `tests/tools/telegram.test.ts`: regression test locking the existing
  `channel_runtime_not_wired` / `channel_runtime_deps_unavailable` branches
  against a future refactor that accidentally makes them the happy path.

### 6.2 E2E / Smoke

- Manual PTY smoke: start REPL with a real Telegram bot token + allowlist
  configured via `nimbus telegram set-token` / `nimbus telegram allow`, ask the
  agent to "kết nối Telegram", approve the tool confirm, verify the REPL
  prints `Telegram online as @<botname> — N user(s) authorised`.

### 6.3 Security Checks

- No new call site writes to `~/.nimbus/.vault-key` or `secrets.enc`. `grep -n
  "writeFile\|autoProvisionPassphrase\|keyring.set" src/channels/runtime.ts` —
  unchanged.

## 7. Interfaces

```ts
// src/core/channelPorts.ts
export interface ChannelService {
  startTelegram(wsId: string, deps?: unknown): Promise<{ botUsername: string }>;
  // ...rest unchanged
}

// src/tools/builtin/Telegram.ts (shape owned here — tools layer)
export interface TelegramRuntimeDeps {
  provider: Provider;
  model: string;
  registry: ToolRegistry;
  gate: Gate;
  cwd: string;
}

// Call pattern (tool side):
const deps = runtimeBridge(ctx);               // TelegramRuntimeDeps | null
if (!deps) throw U_MISSING_CONFIG;
await svc.startTelegram(ctx.workspaceId, deps); // deps flows as `unknown`

// Receive pattern (runtime side):
startTelegram: async (wsId, deps) => {
  if (!deps) throw U_MISSING_CONFIG('channel_runtime_bridge_required');
  const typedDeps = deps as Omit<StartTelegramOptions, 'wsId'>;
  return runtime.startTelegram({ wsId, ...typedDeps });
}
```

## 8. Files Touched

- `src/core/channelPorts.ts` (edit, +4 lines doc + widened sig)
- `src/channels/runtime.ts` (edit, +10 lines — port impl rewrite)
- `src/tools/builtin/Telegram.ts` (edit, +1 line — pass deps arg)
- `tests/tools/telegram.test.ts` (edit, +~60 LoC — two new regression tests)

## 9. Open Questions

- [ ] Multi-process bot conflict (two REPLs + `nimbus telegram` daemon on same
  token) — currently both call `manager.startAll()` and the second Telegram
  long-poll fails with `409 Conflict`. Mitigation deferred to v0.4 daemon
  (§Option C in the fix design).

## 10. Changelog

- 2026-04-17 @hiepht: draft + approved (one-turn fix, user regression from
  v0.3.20 live test — see CHANGELOG.md 0.3.21-alpha entry).
