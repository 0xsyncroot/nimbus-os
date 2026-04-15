---
id: SPEC-401
title: Permission modes + canUseTool gate
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: permissions
depends_on: [META-003, META-009, SPEC-402]
blocks: [SPEC-302, SPEC-303, SPEC-103]
estimated_loc: 150
files_touched:
  - src/permissions/mode.ts
  - src/permissions/gate.ts
  - src/permissions/pathValidator.ts
  - src/permissions/types.ts
  - src/permissions/index.ts
  - tests/permissions/gate.test.ts
  - tests/permissions/pathValidator.test.ts
---

# Permission Modes + canUseTool Gate

## 1. Outcomes

- Every tool call routed through `canUseTool()` returning `'allow' | 'ask' | 'deny'` in <1ms
- v0.1 ships 3 modes: `readonly`, `default`, `bypass` — switchable via `/mode <name>` at runtime
- Path validator rejects sensitive paths (`.env`, `.ssh/`, `id_rsa*`, shell configs, cron spool, nimbus internals) with `X_CRED_ACCESS` / `X_PATH_BLOCKED` — full list in §2.1
- v0.2 expansion adds 3 more modes: `plan`, `auto`, `isolated` (scaffolded, stubs throw `NimbusError(U_MISSING_CONFIG, {mode, reason:'not-implemented-until-v0.2'})`)

## 2. Scope

### 2.1 In-scope
- Mode enum + registry (6 slots, 3 implemented v0.1)
- Core `canUseTool(toolName, input, ctx): Decision` entry point
- Path validator denylist (case-fold, `O_NOFOLLOW` symlink rejection, traversal rejection):
  - **Credentials (T6, T13)**: `.env*`, `.ssh/`, `id_rsa*`, `id_ed25519*`, `.aws/credentials`, `.gcloud/`, `.azure/`, `.kube/config`, `/etc/shadow`, `/etc/passwd` (write), `.netrc`, `.pgpass`, `.docker/config.json`
  - **Shell persistence (T16)**: `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.config/fish/config.fish`, `/etc/cron.d/`, `/etc/crontab`, `~/.config/cron`, spool `var/spool/cron/`, systemd user units `~/.config/systemd/user/`
  - **nimbus internals (T13, T15)**: `~/.nimbus/secrets.enc`, `~/.nimbus/config.json`, `~/.nimbus/logs/`, `~/.nimbus/workspaces/*/http.token`, `~/.nimbus/paired-devices.json`
- Session-scoped decision cache (`ask → allow` remembered until REPL restart) keyed by `{tool, normalizedPattern}` where `normalizedPattern` derives from rule literal (not free-form input) to prevent over-broad caching
- Mode state stored on session object (not global)

### 2.2 Out-of-scope
- Rule parsing/matching → SPEC-402
- Bash tier-1 filter → SPEC-403 / SPEC-303
- Audit trail → SPEC-601 (`SecurityEvent` emitter hooked here, schema owned by 601)
- Network SSRF policy → v0.2
- Sub-agent permission lattice → v0.3

## 3. Constraints

### Technical
- Bun ≥1.2, TS strict, no `any`
- Zero I/O on hot path (mode lookup + in-memory rule match only)
- All rejections throw `NimbusError(ErrorCode.T_PERMISSION | X_PATH_BLOCKED | X_CRED_ACCESS, ctx)`

### Performance
- `canUseTool()` <1ms warm (measured p99 via bench)
- Path validator <0.5ms for typical 200-char path

### Security
- Deny-by-default on unknown mode
- `readonly` mode: Write/Edit/Bash destructive verbs → `deny`, Read/Grep/Glob → `allow`
- `bypass` requires explicit env `NIMBUS_BYPASS_CONFIRMED=1` OR `--dangerously-skip-permissions` CLI flag (logged WARN)

## 4. Prior Decisions

- **3 modes v0.1 (not 6)** — MVP scope; 6 modes expand v0.2 when plan/auto/isolated need design
- **Session-scoped cache, not persistent** — prevents long-lived "yes to all" traps between restarts
- **Deny-on-unknown-tool** — fail-closed stance required for a local OS agent
- **Path validator lives in 40-permissions not storage** — it's a security boundary, grouped with other gates

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Mode enum + registry | All 6 slots typed; 3 impls + 3 stubs throw `NimbusError(U_MISSING_CONFIG, {mode, reason:'not-implemented-until-v0.2'})` | 30 | — |
| T2 | `canUseTool()` core | Unit tests for each mode × {allow, ask, deny} path | 40 | T1, SPEC-402 |
| T3 | Path validator | Rejects `.env`, `.ssh/`, case-fold, symlink, `..` | 50 | T1 |
| T4 | Session cache + `/mode` hook | `ask→allow` persisted until REPL exit | 30 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/permissions/gate.test.ts`:
  - readonly blocks Write/Edit/Bash(rm), allows Read/Grep
  - default: unknown tool → `ask`, matching rule → `allow`/`deny`
  - bypass without env → throws `X_*`, with env → `allow` all
  - `plan`/`auto`/`isolated` stubs throw `U_MISSING_CONFIG` with ctx containing mode name
- `tests/permissions/pathValidator.test.ts`:
  - Credentials (T6/T13): `.env`, `.ENV`, `.Env` all rejected (case-fold); `~/.ssh/id_rsa` → `X_CRED_ACCESS`; `~/.aws/credentials`, `~/.netrc`, `~/.docker/config.json` rejected
  - Shell persistence (T16): `.bashrc`, `.ZSHRC`, `.profile`, `/etc/cron.d/mycron`, `~/.config/systemd/user/foo.service` rejected
  - nimbus internals (T13/T15): `~/.nimbus/config.json`, `~/.nimbus/secrets.enc`, `~/.nimbus/logs/metrics/2026-04-15.jsonl` rejected
  - symlink pointing outside workspace root → rejected (O_NOFOLLOW)
  - `../../../etc/passwd` → rejected

### 6.2 E2E Tests
- `tests/e2e/mode-switch.test.ts`: `/mode readonly` then `nimbus exec "echo x > f"` → exit 1 with `T_PERMISSION`

### 6.3 Performance Budgets
- `canUseTool()` p99 <1ms across 10K rule set (bench)

### 6.4 Security Checks
- TOCTOU: symlink swap between validate and open → second stat re-validates
- Bypass only via explicit env AND CLI flag (both required), never via config file

## 7. Interfaces

```ts
import { z } from 'zod'

export const PermissionModeSchema = z.enum([
  'readonly', 'default', 'bypass',    // v0.1
  'plan', 'auto', 'isolated',         // v0.2 stubs
])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

export type Decision = 'allow' | 'ask' | 'deny'

export interface PermissionContext {
  sessionId: string
  workspaceId: string
  mode: PermissionMode
  cwd: string
}

export interface ToolInvocation {
  name: string                  // 'Bash' | 'Read' | 'Write' | ...
  input: Record<string, unknown>
}

export interface Gate {
  canUseTool(inv: ToolInvocation, ctx: PermissionContext): Promise<Decision>
  rememberAllow(sessionId: string, ruleKey: string): void
}

export function validatePath(abs: string, workspaceRoot: string): void
// throws NimbusError(X_PATH_BLOCKED | X_CRED_ACCESS)
```

## 8. Files Touched

- `src/permissions/mode.ts` (~30 LoC)
- `src/permissions/gate.ts` (~70 LoC)
- `src/permissions/pathValidator.ts` (~50 LoC)
- `tests/permissions/gate.test.ts` (~120 LoC)
- `tests/permissions/pathValidator.test.ts` (~80 LoC)

## 9. Open Questions

- [ ] Should `bypass` be removed entirely in favor of per-rule overrides? (v0.2 discussion)
- [ ] `ask` prompt latency budget when channel is Telegram/Slack (v0.3)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — expand path denylist to cover T6/T13/T16 (shell configs, cron spool, nimbus internals); v0.2 stubs throw `U_MISSING_CONFIG` not `U_BAD_COMMAND`; document session cache key format
