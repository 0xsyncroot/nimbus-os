---
id: SPEC-830
title: UIHost contract — channel-agnostic UI intent primitives
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3
layer: core
pillars: [P3]
depends_on: [META-001, META-003, SPEC-103, SPEC-401]
blocks: [SPEC-831, SPEC-832]
estimated_loc: 180
files_touched:
  - src/core/ui/intent.ts
  - src/core/ui/uiHost.ts
  - src/core/ui/index.ts
  - tests/core/ui/intent.test.ts
  - tests/core/ui/uiHost.test.ts
---

# UIHost contract — channel-agnostic UI intent primitives

## 1. Outcomes

- Core agent loop can request user interaction (confirm / pick / input / status) without importing any channel module; channel picks its own presentation (terminal picker vs Telegram inline_keyboard vs web dashboard modal).
- Telegram channel can finally satisfy approval prompts via the same contract CLI uses — removes dead code in `src/channels/telegram/approval.ts` (Expert 1 §V2, Expert 3 §3).
- Layer violation V1 (`tools/builtin/Telegram.ts` → `channels/`) eliminated: tools emit `UIIntent`, never call a channel.
- Adding a new channel (Slack / HTTP) requires only implementing `UIHost`, not editing `core/loop.ts` or `tools/`.

## 2. Scope

### 2.1 In-scope
- Type `UIIntent` (discriminated union: `confirm | pick | input | status`) defined in pure TS in `src/core/ui/intent.ts`
- Interface `UIHost` with method `ask(intent: UIIntent, ctx: UIContext): Promise<UIResult>` in `src/core/ui/uiHost.ts`
- Type `UIContext` carrying `turnId`, `correlationId`, `channelId`, `abortSignal`
- Type `UIResult` (discriminated on intent kind) with `{ kind: 'ok', value } | { kind: 'cancel' } | { kind: 'timeout' }`
- Barrel re-export from `src/core/ui/index.ts`
- Zod schemas for `UIIntent` payloads (validation at channel boundary)
- Unit tests: payload schema, exhaustive kind switch, cancel/timeout result shape

### 2.2 Out-of-scope (defer to other specs)
- Channel implementations of `UIHost` → SPEC-831 (Telegram), SPEC-832 (CLI)
- Wiring into `loopAdapter.onAsk` → SPEC-831 (done there once Telegram host lands)
- eslint layer enforcement → SPEC-833
- Ink / TUI framework adoption → deferred to v1.0 per Expert 4 plan-alignment

## 3. Constraints

### Technical
- Pure TS: no Bun APIs, no `node:*` imports — reusable from future mobile client
- TypeScript strict, no `any`, `noUncheckedIndexedAccess`
- Max 400 LoC per file; likely ~60 LoC intent + ~40 LoC uiHost + ~40 LoC index
- Functional + closures (no class inheritance)

### Security
- `UIIntent` payloads must be serializable (no functions / bigints) — channels may ship them over the wire
- Telegram channel must validate inbound `UIResult` against `allowedUserIds` before resolving the promise (enforced in SPEC-831, contract notes it)
- No raw secrets in payloads (audit redaction inherited from SPEC-119)

### Performance
- `UIHost.ask()` allocation budget <2 KB; any queue is the channel's problem
- Timeout default = 30 s (matches existing CLI confirm, SPEC-801 §2)

## 4. Prior Decisions

- **Small UIHost, not Ink** — Expert 1 + Expert 3 converge on ~600 LoC fix for today's pain; Expert 2's Ink costs ~4500 LoC + breaks 3 specs (801/822/823) + plan §5 line 319 explicit v1.0+ hold. Defer Ink; ship contract.
- **Intent is data, Host is transport** — lets core emit intents, channel chooses rendering (inline_keyboard vs terminal picker vs HTTP modal). OpenClaw pattern (Expert 3 §2).
- **Discriminated union over class hierarchy** — matches CLAUDE.md §4 "no class inheritance"; also exhaustive switch gives free compile-time safety.
- **Pure TS layer (no Bun)** — META-001 core/ir layering rule; enables reuse from mobile client without bundling Bun.
- **No approvalToken at core layer** — tokens are Telegram-implementation detail; core uses `correlationId` (channel-agnostic).

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | Define `UIIntent` union + Zod schemas | `validate()` rejects malformed, accepts valid fixtures | 60 | — |
| T2 | Define `UIHost` interface + `UIContext` + `UIResult` | TSC compiles, discriminants exhaustive | 40 | T1 |
| T3 | Barrel `index.ts` + re-export types only | Import path `core/ui` resolves in tests | 10 | T2 |
| T4 | Unit tests: schema round-trip + exhaustiveness | 100% branch coverage for helpers | 70 | T2 |

## 6. Verification

### 6.1 Gate A — Reviewer
- reviewer-architect: layering is pure TS, no `channels/` / `tools/` imports
- reviewer-security: `UIIntent.confirm` payload cannot smuggle shell commands; intents are display strings only

### 6.2 Gate B — PTY smoke
- `scripts/pty-smoke/` harness imports `core/ui` in a stub host, asserts `ask()` resolves to `timeout` after 100ms when signal aborted

### 6.3 Gate C — CI
- `bun test tests/core/ui/` green on Linux + macOS + Windows
- `bun run typecheck` green (no `any`, exhaustive switch enforced)
- `bun run spec validate` green

## 7. Interfaces

```ts
// Source of truth — keep in src/core/ui/intent.ts
export type UIIntent =
  | { kind: 'confirm'; prompt: string; defaultValue?: boolean; timeoutMs?: number }
  | { kind: 'pick'; prompt: string; options: Array<{ id: string; label: string; hint?: string }> }
  | { kind: 'input'; prompt: string; secret?: boolean; placeholder?: string }
  | { kind: 'status'; message: string; level: 'info' | 'warn' | 'error' };

export interface UIContext {
  turnId: string;
  correlationId: string;
  channelId: 'cli' | 'telegram' | 'slack' | 'http';
  abortSignal: AbortSignal;
}

export type UIResult<T = unknown> =
  | { kind: 'ok'; value: T }
  | { kind: 'cancel' }
  | { kind: 'timeout' };

export interface UIHost {
  ask<T>(intent: UIIntent, ctx: UIContext): Promise<UIResult<T>>;
}
```

## 8. Files Touched

- `src/core/ui/intent.ts` (new, ~60 LoC)
- `src/core/ui/uiHost.ts` (new, ~40 LoC)
- `src/core/ui/index.ts` (new, ~10 LoC)
- `tests/core/ui/intent.test.ts` (new, ~40 LoC)
- `tests/core/ui/uiHost.test.ts` (new, ~30 LoC)

## 9. Open Questions

- [ ] Should `UIIntent.pick` support multi-select in v0.3? (defer — current picker is single-select)
- [ ] Do we need `progress` intent for long-running tool calls? (defer to v0.4 with SPEC-806r event fanout)

## 10. Changelog

- 2026-04-17 @hiepht: draft initial after Expert 1+3+4 synthesis; supersedes SPEC-825 approach
