---
id: SPEC-404
title: acceptEdits mode — auto-allow write-tier tools
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: permissions
depends_on: [SPEC-401, SPEC-301]
blocks: []
estimated_loc: 90
files_touched:
  - src/permissions/mode.ts
  - src/permissions/gate.ts
  - src/channels/cli/slashCommands.ts
  - tests/permissions/acceptEdits.test.ts
---

# acceptEdits Mode — Auto-Allow Write-Tier Tools

## 1. Outcomes

- `/mode acceptEdits` (alias `/mode auto`) enables autonomous coding: `Write`, `Edit`, `NotebookEdit`, and any tool with `sideEffects: 'write'` are auto-allowed without a prompt
- `Bash` and network tools (`WebFetch`, `WebSearch`) continue to prompt or match existing `allow` rules — exec/network tier is unchanged
- Sub-agents that inherit via `narrow()` receive `acceptEdits` or a narrower mode, never a wider one
- Mode round-trips through `/mode default` and `/mode plan` correctly

## 2. Scope

### 2.1 In-scope
- `PermissionMode` enum extended with `'acceptEdits'`; `'auto'` retained as alias resolved at parse-time to `'acceptEdits'`
- `gate.ts` fast-path: when `ctx.mode === 'acceptEdits'` and `tool.sideEffects === 'write'` → return `'allow'` without cache lookup
- `gate.ts` exec/network path: `sideEffects: 'exec' | 'read' | 'pure'` follow existing mode rules unchanged in `acceptEdits`
- `/mode acceptEdits` and `/mode auto` slash commands (both resolve to same mode state)
- `narrow()` sub-agent lattice: `acceptEdits` narrows to `acceptEdits`, `default`, `readonly`, or `plan`; never widens to `bypass`

### 2.2 Out-of-scope (defer)
- Per-tool whitelist overrides (v0.4) — SPEC-405
- Time-boxed auto-accept sessions (v0.4)
- Network tools auto-allow in any future `acceptEditsPlus` mode (not this spec)
- `bypass` mode changes — SPEC-401 owns that surface

## 3. Constraints

### Technical
- Bun ≥1.2, TS strict, no `any`
- `mode.ts` enum change must be backward-compatible: existing `'auto'` string literals (if any) parse to `'acceptEdits'`
- `gate.ts` hot-path change must keep `canUseTool()` <1ms (no new I/O)
- Sub-agent `narrow()` must enforce: `acceptEdits` cannot widen to `bypass`

### Security
- `sideEffects: 'exec'` (Bash/pwsh) still gated — this mode is NOT `bypass`
- Network tools (`WebFetch`, `WebSearch`, `sideEffects: 'read'` with external I/O) still prompt
- Audit: mode switch logged as `SecurityEvent{eventType:'mode.changed', from, to}` — SPEC-601 schema

### Performance
- No additional cache layer needed; decision is O(1) enum check before existing rule-match path

## 4. Prior Decisions

- **`acceptEdits` name, `auto` alias** — matches Claude Code convention (analyst gap #2); `auto` kept for shorter REPL typing; public surface is `acceptEdits`
- **`sideEffects` enum reuse, no new axis** — SPEC-301 4-category (`pure/read/write/exec`) already partitions exactly what this mode needs; adding a fifth category would be over-engineering
- **Bash still prompts** — unlike Claude Code `bypassPermissions`, nimbus treats Bash as the user's escape hatch; consciously gating it here avoids silent privilege escalation; `bypass` mode (SPEC-401) exists for users who want full automation
- **Sub-agents inherit via `narrow()`, not env copy** — prevents a child agent from silently receiving a wider mode than parent intended; lattice is: `bypass > acceptEdits > default > readonly`, `plan` is orthogonal

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `mode.ts` — add `'acceptEdits'` to enum, alias `'auto'` at parse | `parseMode('auto') === 'acceptEdits'`; `parseMode('acceptEdits')` ok; unknown → throw `NimbusError(U_BAD_COMMAND)` | 15 | SPEC-401 |
| T2 | `gate.ts` — auto-allow `write` sideEffect when mode=`acceptEdits` | unit matrix: 4 modes × 4 sideEffects all correct; `acceptEdits + exec` → `'ask'` | 25 | T1, SPEC-301 |
| T3 | Slash commands `/mode acceptEdits` + `/mode auto` | REPL enters mode; `/mode default` exits; `currentMode()` returns correct value | 10 | T1 |
| T4 | Tests — full matrix + sub-agent `narrow()` | 4 modes × 4 sideEffects (16 cases); alias test; narrow lattice 6 cases | 40 | T2, T3 |

## 6. Verification

### 6.1 Unit Tests — `tests/permissions/acceptEdits.test.ts`

- Mode matrix: `['readonly','default','acceptEdits','bypass'] × ['pure','read','write','exec']` → 16 expected decisions
- Alias resolution: `parseMode('auto') === 'acceptEdits'`
- `canUseTool({sideEffects:'write'}, {mode:'acceptEdits'})` → `'allow'`
- `canUseTool({sideEffects:'exec'}, {mode:'acceptEdits'})` → `'ask'`
- `canUseTool({sideEffects:'write'}, {mode:'readonly'})` → `'deny'`
- `narrow(acceptEdits, bypass)` → throws `NimbusError(T_PERMISSION)` (cannot widen)
- `narrow(acceptEdits, readonly)` → `'readonly'` (valid narrowing)

### 6.2 Integration Test
- Agent in `acceptEdits` mode writes 3 files via `Write` tool: zero prompts, all succeed
- Same agent runs `echo hello` via `Bash`: one prompt emitted
- `/mode default` after session: subsequent `Write` call prompts again

### 6.3 Performance
- `canUseTool()` p99 <1ms with mode=`acceptEdits` across 10K invocations (bench)

### 6.4 Security Checks
- `acceptEdits` + `Bash({command:'rm -rf /'})` → tier-1 block fires before mode check (SPEC-303 unchanged)
- Mode switch logged in audit; `bypass` not reachable via `narrow()` from `acceptEdits`

## 7. Interfaces

```ts
// mode.ts — extended enum
export type PermissionMode =
  | 'readonly'
  | 'default'
  | 'acceptEdits'   // v0.3.1 — alias 'auto'
  | 'bypass'
  | 'plan'
  | 'isolated'      // v0.2 stub

export function parseMode(raw: string): PermissionMode
// 'auto' → 'acceptEdits'; unknown → throw NimbusError(U_BAD_COMMAND, {raw})

// gate.ts — decision logic extension (no new export, internal only)
// When ctx.mode === 'acceptEdits' && tool.sideEffects === 'write' → 'allow'

// narrow() — sub-agent inheritance (existing function, extended validation)
export function narrow(parent: PermissionMode, requested: PermissionMode): PermissionMode
// throws NimbusError(T_PERMISSION) if requested is wider than parent in lattice
```

## 8. Files Touched

- `src/permissions/mode.ts` (extend enum + `parseMode` alias, ~15 LoC delta)
- `src/permissions/gate.ts` (acceptEdits fast-path in `canUseTool`, ~25 LoC delta)
- `src/channels/cli/slashCommands.ts` (register `/mode acceptEdits` + `/mode auto`, ~10 LoC delta)
- `tests/permissions/acceptEdits.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Should `acceptEdits` also auto-allow `sideEffects: 'read'` tools (Read, Grep, Glob)? Current assumption: yes, `read` is already allowed in `default` mode so no change needed. Confirm with v0.3.1 review.
- [ ] Display name in REPL prompt: show `[acceptEdits]` or `[auto]`? Lean toward `[acceptEdits]` for clarity.

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 gap #2 vs Claude Code; acceptEdits mode sweet spot between default and bypass
