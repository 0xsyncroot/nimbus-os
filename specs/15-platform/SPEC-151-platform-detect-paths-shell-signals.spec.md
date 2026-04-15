---
id: SPEC-151
title: Platform detect + paths + shell + signals
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: platform
depends_on: [META-001, META-003, META-010]
blocks: [SPEC-152, SPEC-101, SPEC-102, SPEC-601, SPEC-501]
estimated_loc: 300
files_touched:
  - src/platform/detect.ts
  - src/platform/paths.ts
  - src/platform/shell.ts
  - src/platform/signals.ts
  - src/platform/open.ts
  - src/platform/notifier.ts
  - tests/platform/detect.test.ts
  - tests/platform/paths.test.ts
  - tests/platform/shell.test.ts
  - tests/platform/signals.test.ts
---

# Platform detect + paths + shell + signals

## 1. Outcomes

- Any code that needs OS-aware behavior imports `platform/` and works identically on Windows 10+, macOS 12+, Linux (glibc + musl).
- `paths.configDir()` returns the canonical per-OS directory (XDG / Apple Standard / Windows Known Folder) without caller branching on `process.platform`.
- `shell.detect()` returns `{kind:'bash'|'pwsh'|'cmd', quote(arg)}` so tools produce safe command strings per OS.
- `signals.onInterrupt(cb)` unifies `SIGINT`/`SIGTERM`/`SIGHUP`/`CTRL_BREAK_EVENT` into one subscription primitive for cancellation (consumer: SPEC-103 agent loop).

## 2. Scope

### 2.1 In-scope
- `detect.ts`: `PlatformCaps` object (os, arch, isWSL, isMusl, hasColor, defaultShell, lineEnding).
- `paths.ts`: config/cache/data/logs/state dirs + `nimbusHome()` (root `~/.nimbus/`), `workspacesDir()`, `logsDir()`.
- `shell.ts`: shell detection, quote adapter (POSIX via `shell-quote`, PowerShell via custom quoter), env var override `NIMBUS_SHELL`.
- `signals.ts`: unified `onInterrupt`, `onTerminate`, graceful shutdown registration. Maps Windows to supported equivalents.
- `open.ts`: open URL/file using `open`/`xdg-open`/`start` respectively.
- `notifier.ts`: best-effort desktop toast (osascript / notify-send / BurntToast). Silent fallback when unavailable.

### 2.2 Out-of-scope
- Secrets storage → SPEC-152
- Clipboard → v0.3
- Screenshot → v0.4
- Daemon installers (launchd/systemd/NSSM) → v0.4

## 3. Constraints

### Technical
- Bun ≥1.2, TS strict, no `any`.
- `platform/` leaf module: zero imports from other nimbus modules (per META-001 §2.2).
- Max 400 LoC per file; `detect.ts` ≤ 120, `paths.ts` ≤ 100, `shell.ts` ≤ 120, `signals.ts` ≤ 60.
- On failure to detect, throw `NimbusError(ErrorCode.U_MISSING_CONFIG, {...})` — never silent fallback.

### Performance
- `detect()` synchronous + memoized; first call <5ms, subsequent <0.05ms.
- `paths.configDir()` <1ms (pure string build on top of detect cache).

### Resource
- No background threads, no spawned probes on import. All detection is env/process-based.

## 4. Prior Decisions

- **`@napi-rs/keyring` deferred to SPEC-152** — keep SPEC-151 pure platform primitives; secrets has its own threat surface (T13 in META-009).
- **Custom pwsh quoter (not shelljs)** — why not shelljs: POSIX-only; we need PowerShell `'`/`"`/`` ` `` escaping. Ref: `src/utils/permissions/pathValidation.ts` patterns.
- **XDG on Linux, Apple Standard on macOS, Known Folders on Windows** — why not unified `~/.nimbus`: OS users expect their convention; log locations matter for `tail` / `less` / built-in viewers.
- **`NIMBUS_HOME` env override always wins** — why: test fixtures + portable installs (USB stick, Nix).
- **Signal abstraction, not raw `process.on`** — why: Windows has no `SIGHUP`; abstracting now prevents scattered `if (process.platform === 'win32')` in loop/daemon (SPEC-103, v0.4 daemon).
- **`ShellAdapter.kind` limited to `bash`/`pwsh`/`cmd`** — why not enumerate `zsh`/`fish`: they are POSIX-quote-compatible, so mapping `zsh`→`bash`-kind and `fish`→`bash`-kind yields correct quoting. `PlatformCaps.defaultShell` preserves the user's actual shell string for display; `ShellAdapter.kind` drives only quoting + security-validator selection.
- **`PlatformCaps.isMusl: boolean` (not `libc: 'glibc'|'musl'`)** — why: v0.1 only needs to know if musl-specific fallbacks trigger (e.g., keyring binary missing, SPEC-152). Future variants (uClibc, Bionic) would require extending to string union — acceptable breaking change then since no current caller branches on exact libc string.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `detect.ts` + `PlatformCaps` Zod | returns correct caps per OS; WSL detected via `/proc/version` microsoft token; memoized | 80 | — |
| T2 | `paths.ts` per-OS dirs + `NIMBUS_HOME` override | matches reference table (§7); test per OS via mocked `process.platform` + env | 70 | T1 |
| T3 | `shell.ts` detect + POSIX quote + pwsh quote | `quote(["rm","a b"])` → `rm 'a b'` (POSIX) / `rm 'a b'` (pwsh); `NIMBUS_SHELL` override | 100 | T1 |
| T4 | `signals.ts` onInterrupt/onTerminate unified | SIGINT fires on Linux/macOS, CTRL_C fires on Windows via `process.on('SIGINT')` | 40 | — |
| T5 | `open.ts` URL/file launcher | exits 0 after spawning `open`/`xdg-open`/`start`; no blocking wait | 30 | T1 |
| T6 | `notifier.ts` silent-fallback toast | calling `notify("...")` on unsupported env returns `false`, no throw | 40 | T1 |
| T7 | Tests per OS (CI matrix) | all 4 tests pass on ubuntu-22.04, macos-14, windows-2022 GitHub runners | 150 | T1-T6 |

## 6. Verification

### 6.1 Unit Tests
- `tests/platform/detect.test.ts`:
  - `describe('SPEC-151: detect')` → test each of linux/darwin/win32 via mock; WSL detection via fixture `/proc/version`.
- `tests/platform/paths.test.ts`:
  - macOS: `configDir()` === `~/Library/Application Support/nimbus`
  - Linux: `configDir()` === `${XDG_CONFIG_HOME:-~/.config}/nimbus`
  - Windows: `configDir()` === `${APPDATA}\nimbus`
  - `NIMBUS_HOME=/tmp/x` override applied to all dirs.
- `tests/platform/shell.test.ts`:
  - POSIX quote: edge cases (spaces, `$`, `` ` ``, single/double quotes, `\n`).
  - pwsh quote: `'hello'' world'` round-trip via `Invoke-Expression`-safe.
  - `NIMBUS_SHELL=bash` on Windows: forces POSIX path.
- `tests/platform/signals.test.ts`:
  - `onInterrupt(cb)` → dispatched SIGINT → cb called once; returns unsubscribe handle.

### 6.2 E2E Tests
- CI matrix `ubuntu-22.04`, `macos-14`, `windows-2022`: `bun test tests/platform/` all green.

### 6.3 Performance Budgets
- `detect()` first call <5ms via `bun:test` `bench`.
- Memoization: second call <0.05ms.

### 6.4 Security Checks
- Quote tests exhaust all metacharacters from plan §7 (`$()`, backticks, IFS, `\n`, `\r`, null byte).
- No dynamic `eval`/`Function()`.
- `paths.*()` return values normalize separators; reject `..` in overrides (throw `X_PATH_BLOCKED`).

## 7. Interfaces

```ts
// detect.ts
export const PlatformCapsSchema = z.object({
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['x64', 'arm64']),
  isWSL: z.boolean(),
  isMusl: z.boolean(),
  defaultShell: z.enum(['bash', 'zsh', 'fish', 'pwsh', 'cmd']),
  lineEnding: z.enum(['\n', '\r\n']),
  hasColor: z.boolean(),
})
export type PlatformCaps = z.infer<typeof PlatformCapsSchema>
export function detect(): PlatformCaps // memoized

// paths.ts
export function nimbusHome(): string          // NIMBUS_HOME || per-OS data dir
export function configDir(): string
export function cacheDir(): string
export function dataDir(): string
export function logsDir(): string
export function stateDir(): string
export function workspacesDir(): string       // <dataDir>/workspaces

// shell.ts
export interface ShellAdapter {
  readonly kind: 'bash' | 'pwsh' | 'cmd'
  quote(args: string[]): string
  parseForAudit(cmd: string): string[]         // AST parse via shell-quote
}
export function detectShell(): ShellAdapter

// signals.ts
export type Disposable = () => void
export function onInterrupt(cb: () => void): Disposable
export function onTerminate(cb: () => void): Disposable

// open.ts
export async function openPath(target: string): Promise<void>  // URL or file path

// notifier.ts
export async function notify(title: string, body?: string): Promise<boolean>
```

## 8. Files Touched

- `src/platform/detect.ts` (new, ~80 LoC)
- `src/platform/paths.ts` (new, ~70 LoC)
- `src/platform/shell.ts` (new, ~100 LoC)
- `src/platform/signals.ts` (new, ~40 LoC)
- `src/platform/open.ts` (new, ~30 LoC)
- `src/platform/notifier.ts` (new, ~40 LoC)
- `tests/platform/*.test.ts` (new, ~150 LoC combined)

## 9. Open Questions

- [ ] WSL2 — treat as Linux for paths (`~/.config/nimbus`) or Windows (`%APPDATA%`)? **Default: Linux**; user override via `NIMBUS_HOME`.
- [ ] Git Bash on Windows — detect as `bash` or `pwsh`? **Default: bash if `MSYSTEM` set, pwsh otherwise.**

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
