---
id: SPEC-303
title: Bash + pwsh tool with tier-1 security
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: tools
depends_on: [SPEC-301, SPEC-401, SPEC-402, META-009]
blocks: [SPEC-103]
estimated_loc: 380
files_touched:
  - src/tools/builtin/Bash.ts
  - src/permissions/bashSecurity.ts
  - src/permissions/pwshSecurity.ts
  - src/permissions/shellSecurityDispatcher.ts
  - src/permissions/commandParser.ts
  - tests/permissions/bashSecurity.test.ts
  - tests/permissions/bashSecurity.bypass.test.ts
  - tests/permissions/bashSecurity.t16.test.ts
  - tests/permissions/pwshSecurity.test.ts
---

# Bash + PowerShell Tool with Tier-1 Security

## 1. Outcomes

- Agent runs shell commands in a bounded, timeout-limited child process
- 12 tier-1 bash patterns (META-009 T5/T6/T7/T8/T9/T13/T15/T16) rejected with `X_BASH_BLOCKED` BEFORE spawn — 100% coverage per pattern
- PowerShell equivalents (TR-*P) rejected via `pwshSecurity.ts`
- `cmd.exe` unsupported (dispatcher fail-closed)

## 2. Scope

### 2.1 In-scope
- `Bash` tool: Zod input (`command`, `timeoutMs`, `cwd?`), `Bun.spawn`, 10KB-per-stream capture cap
- `bashSecurity.check(cmd)` — 12 tier-1 rules (TR-1…TR-12)
- `pwshSecurity.check(cmd)` — pwsh equivalents (TR-*P)
- `shellSecurityDispatcher(shell, cmd)` — routes bash/pwsh; cmd.exe → `X_BASH_BLOCKED`
- `commandParser` AST via `shell-quote` (POSIX) + custom pwsh tokenizer; captures subshells, pipes, redirects, heredocs, brace/parameter expansion, env assignments
- Secret-pattern output redaction (reuse SPEC-302 Grep redactor)

### 2.2 Out-of-scope (defer)
- Tier-2 contextual (`rm -rf` scope-aware) → v0.2
- Sandbox (`unshare -n`, chroot) → v0.2 `safety/sandbox.ts`
- ulimit / rate limit → v0.2
- `cmd.exe` support — always rejected; git-bash MSYS2 treated as bash

## 3. Constraints

### Technical
- `Bun.spawn` with `stdio: ['ignore','pipe','pipe']`, signal wired to tool abort
- Timeout default 120s, max 600s hard cap
- stdout/stderr capped 10KB each
- TypeScript strict; each security file ≤400 LoC

### Security (CRITICAL)
- All checks pure functions (no I/O) — deterministic, testable
- Validator runs BEFORE `spawn()`
- Tier-1 match → `throw NimbusError(X_BASH_BLOCKED, {rule, reason})` — NO bypass flag in v0.1
- Audit: SHA-256 digest of command in `SecurityEvent` (raw cmd NEVER stored; leaks API keys/paths)

## 4. Prior Decisions

- **Pattern blocklist v0.1, not sandbox** — sandbox is v0.2. Documented in docs/security.md as first-line defense only.
- **Block, don't warn** — any tier-1 = hard block, no user-confirm bypass. LLM cannot distinguish intent from prompt injection; confirm is fatigue-prone. Bypass arrives v0.2 with sandbox isolation.
- **`shell-quote` AST parse + regex supplement** — regex alone misses Unicode escapes (`$\u0028`) and structural hiding. AST handles structure; regex handles literals.
- **SHA-256 digest in audit** — commands carry secrets. Digest enables dedup + analytics without PII.
- **pwsh not cmd.exe on Windows** — pwsh 7+ ships everywhere, syntactically closer to POSIX. cmd.exe quote semantics unworkable.

## 5. Task Breakdown

| ID | Task | Acceptance | LoC |
|----|------|------------|-----|
| T1 | `commandParser.ts` AST (POSIX + pwsh) | fixtures catch subshells, pipes, heredoc `<<EOF` / `<<<`, brace, `${X:-default}`, env assignments | 70 |
| T2 | `bashSecurity.ts` — 12 TR rules | 100% pattern coverage; returns `{blocked, rule:'TR-N'}` | 110 |
| T3 | `pwshSecurity.ts` — TR-*P equivalents | catches TR-1P…TR-11P (see §6.1) | 80 |
| T4 | `shellSecurityDispatcher.ts` — route by shell | bash/pwsh routed; cmd.exe / unknown → fail-closed | 20 |
| T5 | `Bash.ts` tool | `ls` works; `rm -rf /` blocked pre-spawn; abort kills child <500ms | 80 |
| T6 | Audit: `SecurityEvent{eventType, threat:'T-N', severity, payloadDigest}` on block | SHA-256 digest, never raw | 20 |

## 6. Verification

### 6.1 Unit Tests — Tier-1 rules (summary)

Each rule has ≥3 positive (block) + ≥2 negative (allow) tests in `tests/permissions/bashSecurity.test.ts`. Full fixtures live in the test file.

| Rule | Threat | Summary | Example block / allow |
|------|--------|---------|------------------------|
| TR-1 | T6 | Root/home destructive delete | Block `rm -rf /`, `rm -rf --no-preserve-root /`, `rm -rf $HOME` / Allow `rm -rf ./build/` |
| TR-2 | T5 | Curl/wget pipe to shell | Block `curl X \| sh`, `wget -qO- X \| bash` / Allow `curl X -o file` |
| TR-3 | T5 | Command substitution + expansion evasion | Block `$()`, backticks, env-assign+var-use, brace `{a,b}`, `${X:-default}` / Allow quoted literals |
| TR-4 | T5 | Interpreter `-c/-e` + eval/source/heredoc | Block `python -c`, `node -e`, `eval`, `source /tmp/…`, `. /tmp/…`, `bash <<EOF`, `bash <<<`, base64/hex decode→interp / Allow file-arg scripts under workspace |
| TR-5 | T7 | Fork bomb | Block `:(){ :\|:& };:` and variants / Allow normal functions |
| TR-6 | T5 | Env injection: IFS/PATH/LD_*/DYLD_*/NODE_OPTIONS/PYTHONPATH | Block any assignment of these / Allow benign `FOO=bar cmd` |
| TR-7 | T5 | Privilege escalation | Block `sudo`, `doas`, `pkexec`, `su` (all forms) / Allow none |
| TR-8 | T5 | Process substitution `<()`/`>()` | Block all / Allow none |
| TR-9 | T6, T13 | Credential path access | Block denylist: `.ssh/`, `*.env*`, `.aws/credentials`, `.gnupg/`, `.netrc`, `.docker/config.json`, `.kube/config`, `.npmrc`, `.pypirc`, `/etc/shadow`, `/etc/passwd`, nimbus secrets/config, shell rc files / case-insensitive on APFS/NTFS |
| TR-10 | T8 | Cloud metadata IPs | Block `169.254.169.254`, `fd00:ec2::254`, `metadata.{google,azure,oraclecloud}`, AliCloud `100.100.100.200` / Allow public hosts |
| TR-11 | **T16** | Persistence (shell configs, cron, init, launchd, systemd) | Block writes/edits to shell rc files, cron spool + cron.{d,daily,hourly,weekly,monthly}, `/etc/crontab`, launchd plists (`~/Library/LaunchAgents`, `~/.launchd.plist`), systemd units (`/etc/systemd/system`, `~/.config/systemd/user`), `/etc/init.d`, `/etc/rc.local`, `/etc/profile.d`, Windows Run keys (via TR-11P) |
| TR-12 | T15 | Audit-log tampering | Block touch of `~/.nimbus/{logs,audit}/`, `~/.nimbus/workspaces/*/sessions/*.jsonl` |

Additional outright-blocked (no TR number, tested alongside TR-1): `dd of=/dev/sda`, `mkfs.*`, `shutdown`, `reboot`, `systemctl`, `chmod 777 -R /`.

### 6.1 pwsh rules (`tests/permissions/pwshSecurity.test.ts`)

TR-*P mirrors bash: TR-1P `Remove-Item -Recurse /`; TR-2P `iwr|iex`; TR-3P `ScriptBlock::Create`; TR-4P `Invoke-Expression`, `Add-Type`, `[Reflection.Assembly]::Load`; TR-6P `Set-ExecutionPolicy Bypass`; TR-7P `Start-Process -Verb RunAs`; TR-9P credential paths + Credential Manager; TR-11P `HKCU/HKLM\...\Run`, Startup folder, `Register-ScheduledTask`.

### 6.1 Bypass regression (`tests/permissions/bashSecurity.bypass.test.ts`)

19 named tests, each mapping input → expected rule id. Categories: variable expansion (TR-3), decode-then-exec pipes base64/hex (TR-2/TR-4), heredoc + here-string (TR-4), eval + source families (TR-4), brace expansion (TR-3), parameter default (TR-3), Unicode/hex escapes (TR-3), backslash line-continuation (TR-1), quote splicing (TR-1). Full inputs in the test file.

### 6.1 META-009 T16 trace (`tests/permissions/bashSecurity.t16.test.ts`)

13 cases exercising TR-11, one per persistence class. Each blocks AND emits `SecurityEvent{threat:'T16', severity:'critical'}`. Classes: shell rc (`.bashrc/.zshrc/.profile/.bash_profile`), cron (spool + `/etc/cron.{d,daily,hourly}`), systemd user + system units, macOS launchd plist, boot (`/etc/rc.local`, `/etc/profile.d/*.sh`).

### 6.2 Integration Tests

`tests/tools/builtin/Bash.test.ts`:
- `ls` → exit 0, stdout captured
- stdout >10KB truncated with marker
- Timeout 100ms on `sleep 1` → `T_TIMEOUT`, child killed
- Abort during `sleep 5` → killed <500ms
- Output with `sk-ant-api03-…` → redacted

### 6.4 Security Checks

- Every block → `SecurityEvent{payloadDigest: sha256(cmd)}` — raw cmd never persisted
- Fuzz 10k variations per rule confirm no false-negatives across obfuscation vectors listed in `bashSecurity.bypass.test.ts`
- Dispatcher `cmd.exe` → fail-closed with `SecurityEvent{reason:'cmd.exe unsupported'}`

## 7. Interfaces

```ts
// commandParser.ts
export interface ParsedCommand {
  shell: 'bash' | 'pwsh'
  tokens: Array<string | { op: string }>
  subshells: string[]
  pipes: string[][]
  redirects: Array<{ op: string; target: string }>
  processSub: string[]
  interpreterArgs: Array<{ interp: string; flag: '-c' | '-e'; body: string }>
  envAssignments: Array<{ name: string; value: string }>
  heredocs: Array<{ interp: string; body: string }>
  braceExpansion: string[]
  parameterExpansion: Array<{ name: string; default?: string }>
  hasBackticks: boolean
  hasSudo: boolean
}
export function parseBash(cmd: string): ParsedCommand
export function parsePwsh(cmd: string): ParsedCommand

// bashSecurity.ts
export type SecurityRuleId =
  | 'TR-1' | 'TR-2' | 'TR-3' | 'TR-4' | 'TR-5' | 'TR-6'
  | 'TR-7' | 'TR-8' | 'TR-9' | 'TR-10' | 'TR-11' | 'TR-12'
  | 'TR-1P' | 'TR-2P' | 'TR-3P' | 'TR-4P' | 'TR-6P' | 'TR-7P' | 'TR-9P' | 'TR-11P'

export interface SecurityCheckResult {
  ok: boolean
  rule?: SecurityRuleId
  reason?: string
  threat?: string            // META-009 T-number for audit
}
export function checkBashCommand(cmd: string): SecurityCheckResult
export function checkPwshCommand(cmd: string): SecurityCheckResult
export function checkShellCommand(shell: 'bash' | 'pwsh', cmd: string): SecurityCheckResult

// Bash.ts tool
export const BashInputSchema = z.object({
  command: z.string().min(1).max(16_000),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cwd: z.string().optional(),
  description: z.string().max(120).optional(),
}).strict()

export function createBashTool(deps: {
  shell: 'bash' | 'pwsh'
  pathValidator: PathValidator
  emitSecurityEvent: (ev: SecurityEvent) => void
}): Tool<BashInput, BashOutput>
```

## 8. Files Touched

- `src/tools/builtin/Bash.ts` (~80 LoC)
- `src/permissions/commandParser.ts` (~70 LoC)
- `src/permissions/bashSecurity.ts` (~110 LoC)
- `src/permissions/pwshSecurity.ts` (~80 LoC)
- `src/permissions/shellSecurityDispatcher.ts` (~20 LoC)
- `tests/permissions/bashSecurity.test.ts` (~250 LoC, per-rule exhaustive)
- `tests/permissions/bashSecurity.bypass.test.ts` (~150 LoC, 19 named bypass cases)
- `tests/permissions/bashSecurity.t16.test.ts` (~80 LoC, 13 T16 persistence cases)
- `tests/permissions/pwshSecurity.test.ts` (~120 LoC)
- `tests/tools/builtin/Bash.test.ts` (~100 LoC)

## 9. Open Questions

- [ ] TR-7 allowlist for known-safe invocations (e.g. `sudo -n true`)? Lean no in v0.1.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: round-1 revise — 12 tier-1 rules; TR-3/4/6 bypass coverage; pwsh TR-*P numbering; cmd.exe fail-closed
- 2026-04-15 @hiepht: round-2 revise — explicit bypass regression + T16 trace test files; TR-11 cites T16 by name
- 2026-04-15 @hiepht: round-3 trim — moved bypass/T16 case enumerations into test-file references; replaced verbose TR-1…TR-12 per-rule block lists with compact summary table (full fixtures in `tests/permissions/bashSecurity*.ts`). Target <1500 words met.
