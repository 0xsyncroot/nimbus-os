---
id: SPEC-851
title: repl.ts Ink integration glue — startRepl entry point
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
implemented: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, SPEC-841, SPEC-842, SPEC-848]
blocks: []
estimated_loc: 200
files_touched:
  - src/channels/cli/repl.ts
  - src/channels/cli/repl.legacy.ts
  - src/channels/cli/ink/repl.tsx
  - src/channels/cli/ink/uiHost.tsx
  - tests/channels/cli/repl.test.ts
  - scripts/pty-smoke/ink-repl.ts
---

# repl.ts Ink Integration Glue — startRepl Entry Point

## 1. Outcomes

- `startRepl()` mounts the full Ink `<App>` by default, composing `PromptInput` + `StatusLine` + `SlashAutocomplete` + top-level `<App>` from SPEC-840/841/842/848.
- `NIMBUS_UI=legacy` env flag restores the previous readline path for 1 release cycle, with a deprecation notice printed to stderr.
- `src/channels/cli/repl.ts` shrinks from ~697 LoC to ~200 LoC (remove legacy inline logic; move Ink wiring to `ink/repl.tsx`).
- SIGINT (Ctrl-C) and SIGTERM both trigger clean Ink unmount + terminal restore before process exit.
- Event bus subscriptions (tool events, cost updates, agent-loop status) are wired in `ink/repl.tsx` and torn down on unmount.

## 2. Scope

### 2.1 In-scope
- `startRepl(ctx: ReplContext): Promise<void>` — chooses Ink vs legacy path.
- New `src/channels/cli/ink/repl.tsx` (~100 LoC) — Ink app root: composes `<App>`, wires event bus, registers `cliUIHost`, handles cleanup.
- Refactor `src/channels/cli/repl.ts` to be a thin dispatcher (~200 LoC).
- `makeOnAsk` legacy fallback deletion timeline: mark deprecated now, delete in v0.4.1.
- SIGINT/SIGTERM cleanup: `process.on('SIGINT')`, `process.on('SIGTERM')` → unmount Ink → `process.exit(0)`.
- `cliUIHost` creation and registration with the WorkspaceManager.

### 2.2 Out-of-scope (defer to other specs)
- `<App>` component implementation → SPEC-840
- `PromptInput` component → SPEC-841
- `SlashAutocomplete` → SPEC-842
- `StatusLine` / `TaskListV2` → SPEC-848
- Alt-screen modals → SPEC-847
- PTY smoke infrastructure → referenced in Gate B (META-011 §6.2)

## 3. Constraints

### Technical
- Bun ≥1.2; `ink@7`, `react@19`.
- TypeScript strict, no `any`.
- Max 400 LoC per file. `repl.ts` target: ≤200 LoC. `ink/repl.tsx` target: ≤100 LoC.
- SPEC-833 layer rule: `channels/cli/` MUST NOT import `tools/` directly — all tool events arrive via event bus.
- `NIMBUS_UI=legacy` detection in `repl.ts` before any Ink import (avoid loading React in legacy mode).

### Performance
- Ink app mount ≤50ms warm (from `startRepl()` call to first render frame).
- Legacy path adds zero overhead when `NIMBUS_UI=legacy` is set.

### Resource / Business
- Legacy path removed in v0.4.1; document in CHANGELOG + print deprecation warning on stderr.

## 4. Prior Decisions

- **Dispatcher in `repl.ts`, Ink root in `ink/repl.tsx`** — keeps the legacy/Ink branch outside TSX files; `repl.ts` remains plain TS importable by tests without JSX transform.
- **Event bus wired in `ink/repl.tsx`, not `<App>`** — `<App>` (SPEC-840) is a pure component; side-effectful bus subscriptions belong in the entry file that owns lifecycle.
- **`cliUIHost` created here** — WorkspaceManager needs the UIHost before the Ink app renders the first prompt; creation order: `cliUIHost` → register → `render(<App>)`.
- **No lazy Ink import** — Ink is a compile-time dep in the binary; dynamic import adds latency for no gain.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `startRepl()` dispatcher | `NIMBUS_UI=legacy` → readline path + deprecation warning; default → Ink path | 40 | — |
| T2 | `ink/repl.tsx` Ink root | Mounts `<App>`, registers event bus subs, creates `cliUIHost`, registers with WM | 100 | SPEC-840 T1 |
| T3 | SIGINT/SIGTERM cleanup | Both signals unmount Ink cleanly before exit; terminal not left garbled | 20 | T2 |
| T4 | Shrink `repl.ts` | Remove `makeOnAsk`, inline picker logic, dead `idleHeartbeat` refs; ≤200 LoC | 40 | T1 |
| T5 | Unit tests | Legacy flag test; Ink mount smoke (ink-testing-library); SIGINT teardown | 60 | T1, T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/channels/cli/repl.test.ts`:
  - `NIMBUS_UI=legacy` → readline path invoked, stderr includes deprecation string.
  - Default → `render()` called with `<App>` (mock Ink render).
  - SIGINT handler: `unmount()` called before `process.exit`.
  - Event bus: subscription created on mount, torn down on unmount.

### 6.2 E2E Tests (Gate B PTY smoke)
- PTY REPL smoke (META-011 §6.2 smoke #1):
  - Vietnamese multi-byte paste + Enter works end-to-end.
  - `/help` → overlay renders → Esc dismisses.
  - Tool confirm flow (mock Write tool) → Yes → allowed.
  - Ctrl-C exits cleanly (exit code 0, no garbled terminal).
  - `NIMBUS_UI=legacy` flag restores readline; PTY input still works.

### 6.3 Performance Budgets
- `startRepl()` to first Ink render frame: <50ms warm, measured in PTY smoke.

### 6.4 Security Checks
- No direct tool imports in `repl.ts` or `ink/repl.tsx` (SPEC-833 lint rule passes).
- SIGTERM cannot leave alt-screen active (verify terminal mode restored).

## 7. Interfaces

```ts
// src/channels/cli/repl.ts

export interface ReplContext {
  workspace: WorkspaceSummary;
  agentLoop: AgentLoop;
  eventBus: EventBus;
  config: ResolvedConfig;
}

/**
 * Start the REPL. Mounts Ink <App> unless NIMBUS_UI=legacy.
 * Does not return until the session ends (Ctrl-C or /exit).
 */
export function startRepl(ctx: ReplContext): Promise<void>
```

```tsx
// src/channels/cli/ink/repl.tsx

interface InkReplProps {
  ctx: ReplContext;
  uiHost: CliUIHost;
}

/** Ink app root. Composes <App> with all phase-E-D-C components. */
export function InkRepl({ ctx, uiHost }: InkReplProps): React.ReactElement
```

## 8. Files Touched

- `src/channels/cli/repl.ts` (rewrite, ~200 LoC — was ~697)
- `src/channels/cli/ink/repl.tsx` (new, ~100 LoC)
- `tests/channels/cli/repl.test.ts` (new/update, ~80 LoC)

## 9. Open Questions

- [ ] Should `makeOnAsk` legacy path warn once per session or per invocation? (decide in impl; once-per-session preferred)
- [ ] v0.4.1 deletion: automated lint rule to fail if `NIMBUS_UI=legacy` branch still present? (add to SPEC-849 keybinding manager cleanup task)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — defines the missing composition layer between child SPECs)
