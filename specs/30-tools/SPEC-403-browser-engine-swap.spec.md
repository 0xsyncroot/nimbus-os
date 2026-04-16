---
id: SPEC-403
title: Browser engine swap to agent-browser CDP daemon
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: tools
depends_on: [SPEC-301, SPEC-401, SPEC-152, SPEC-103, META-003, META-009]
blocks: []
estimated_loc: 770
files_touched:
  - src/tools/builtin/browser/engine.ts
  - src/tools/builtin/browser/engines/agentBrowser.ts
  - src/tools/builtin/browser/engines/playwrightCore.ts
  - src/tools/builtin/browser/binaryInstaller.ts
  - tests/tools/builtin/browser/engine.test.ts
---

# Browser engine — swap to agent-browser CDP daemon, keep 9-tool surface

## 1. Outcomes

- 9-tool surface unchanged to agent (navigate/snapshot/click/fill/select/extract/back-forward-reload/tabs/wait-key)
- Engine swappable via `workspace.json` `browser.engine` default `agent-browser`
- Binary auto-downloaded to `~/.nimbus/bin/agent-browser-{platform}-{arch}` with sha256 pin + verify on launch
- `no_evaluate` preserved — adapter strips `eval/HAR/drag/video/PDF/multi-tab` verbs → `ErrorCode.T_PERMISSION`
- Compiled nimbus binary shrinks ≥300MB vs playwright-core-only path

## 2. Scope

### 2.1 In-scope

- Engine adapter interface (`BrowserEngine { navigate, snapshot, click, fill, ... }`)
- `agentBrowser` adapter: shell-out via `Bun.spawn` to Rust CDP daemon, JSON-RPC over stdin/stdout
- `playwrightCore` adapter: fallback engine for dev/recovery
- Binary installer: hardcoded GitHub release URL template in source, sha256 hashes embedded at compile time (not fetched from same channel — defense against DNS hijack per security review), `~/.nimbus/bin/` storage
- Ax-tree translation: `@eN` (agent-browser) ↔ `ref=eN` (nimbus contract)
- Singleton engine manager with healthcheck + auto-restart on daemon crash (exponential backoff 1s/2s/4s, max 3 retries, then surface error)
- Daemon RSS monitoring: kill + restart if exceeding 512MB threshold (OOM defense)
- IPC session nonce/challenge on init + verify spawned PID (TOCTOU defense against daemon replacement)
- Navigate URL validation: route through `ssrfGuard.ts` before passing to daemon (blocks `http://169.254.169.254/` etc.)
- Credential vault wiring: adopt agent-browser auth-vault + domain-allowlist (fulfills v0.5 hardening)
- Verb stripping: `eval`, `HAR`, `video`, `PDF`, `drag`, `multi-tab` → `T_PERMISSION` error

### 2.2 Out-of-scope

- Lightpanda engine swap — post v0.5
- Cloud providers (Browserbase/Kernel) — post v0.5
- Agent-browser skill registry — not needed
- Full multi-tab coordination — refused at adapter

## 3. Constraints

### Technical
- Apache-2.0 upstream (Vercel agent-browser) compat w/ PolyForm NC — we're consumer
- No binary bundled in nimbus SEA — always downloaded at first use
- Semver minor pin for agent-browser (avoid verb-set drift)
- `Bun.spawn` for IPC, cross-platform (Linux/macOS/Windows)

### Performance
- Cold snapshot <250ms, warm <100ms
- Engine startup <2s including healthcheck

### Security
- sha256 pin verified on every launch (supply-chain defense)
- Corrupted/tampered binary → refuse startup with `NimbusError(X_AUDIT_BREAK)`
- No `eval` verb — always return `T_PERMISSION`

## 4. Prior Decisions

- **BORROW not REPLACE** — keep nimbus 9-tool surface + `no_evaluate` refusal (safety + minimalism)
- **agent-browser over playwright-core default** — saves ~780 LoC (1550→770), ~300MB binary, free credential-vault + domain-allowlist
- **playwright-core kept as fallback** — for dev/recovery or if daemon unavailable
- **Shell-out over library binding** — avoids Rust FFI complexity in Bun
- **sha256 pin over TOFU** — supply-chain hardening; binary hash committed to nimbus source
- **Healthcheck + auto-restart** — daemon crash ≠ in-proc exception, needs explicit handling
- **Semver minor pin** — prevents upstream verb-set drift breaking our contract

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Binary installer + sha256 pin | download + verify + store; corrupted → refuse | 80 | — |
| T2 | JSON-RPC client over Bun.spawn | connect/disconnect/call/timeout | 120 | T1 |
| T3 | Ax-tree `@eN`↔`ref=eN` adapter | 20-case fixture translation | 60 | — |
| T4 | Verb mapping to 9-tool dispatch | all 9 tools work; eval/HAR → T_PERMISSION | 150 | T2,T3 |
| T5 | Credential vault wiring | auth-vault + domain-allowlist integrated | 80 | T4 |
| T6 | E2E tests against httpbin + local | navigate+snapshot+click+extract on 3 fixtures | 200 | T4 |
| T7 | Fallback path to playwright-core | engine=playwright-core works same 9 tools | 40 | T4 |
| T8 | SPEC-103 side-effects + docs | side-effects entries updated | 40 | T4 |

## 6. Verification

### 6.1 Unit Tests
- Adapter translation (ax-tree), verb stripping → T_PERMISSION, binary hash verify

### 6.2 E2E Tests
- Navigate + snapshot + click + extract on 3 fixture sites
- Fallback to playwright-core when daemon unavailable

### 6.3 Performance Budgets
- Cold snapshot <250ms via `bun:test` bench

### 6.4 Security Checks
- `eval` verb returns `T_PERMISSION`
- `HAR` verb returns `T_PERMISSION`
- Corrupted binary → startup refuses with `X_AUDIT_BREAK`

## 7. Interfaces

```ts
interface BrowserEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  navigate(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  snapshot(opts?: { includeScreenshot?: boolean }): Promise<AxTreeSnapshot>;
  click(ref: string, opts?: { button?: string }): Promise<void>;
  fill(ref: string, value: string, opts?: { submit?: boolean }): Promise<void>;
  select(ref: string, values: string[]): Promise<void>;
  extract(opts?: { mode?: 'markdown' | 'text' | 'html' }): Promise<string>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  tabs(action: 'list' | 'new' | 'switch' | 'close', opts?: { id?: string }): Promise<TabInfo[]>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
}

type EngineKind = 'agent-browser' | 'playwright-core';
```

## 8. Files Touched

- `src/tools/browser/engine.ts` (new, ~40 LoC — interface + factory)
- `src/tools/browser/engines/agentBrowser.ts` (new, ~300 LoC)
- `src/tools/browser/engines/playwrightCore.ts` (new, ~200 LoC)
- `src/tools/browser/binaryInstaller.ts` (new, ~80 LoC)
- `tests/tools/browser/engine.test.ts` (new, ~200 LoC)

## 9. Open Questions

- [ ] Should binary auto-update be opt-in or opt-out? (defer to v0.5 auto-updater)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on OpenClaw tool audit + agent-browser deep-compare
