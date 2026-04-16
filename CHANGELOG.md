# Changelog — nimbus-os

All notable changes to nimbus-os. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.3.7-alpha] — 2026-04-16 — URGENT fix (binary upgrade silently locks existing vault → misleading "no key" error)

User repro (v0.3.6 → new shell):

```
personal › hello
[ERROR] U_MISSING_CONFIG: {"reason":"provider_key_missing","provider":"openai",
  "hint":"run `nimbus key set openai` or set OPENAI_API_KEY"}
```

The user had a valid `sk-...` stored via `nimbus key set` on v0.3.4 (shell had
`NIMBUS_VAULT_PASSPHRASE=...` set). After upgrading to v0.3.6 and opening a
fresh shell **without** the env var, the error above appeared — telling them
to set a key that was already saved and claiming a config file issue when the
real problem was a locked vault. The message was raw JSON, in English, and
pointed at the wrong fix (`nimbus key set` would just overwrite nothing
useful at that stage since the passphrase was still wrong).

### Root cause

Two silent-failure bugs compounded:

1. `autoProvisionPassphrase()` (called on every REPL boot and most `nimbus
   key` / `nimbus telegram` handlers) would, when no passphrase source was
   available, **auto-generate a random passphrase and write it to
   `~/.nimbus/.vault-key`** — even when a vault already existed that needed a
   different passphrase. From that point the `.vault-key` file masked the
   user's original passphrase, and `secrets.enc` was effectively unreadable
   unless the user knew to delete `.vault-key` manually (nobody does).

2. `resolveProviderKey()` wrapped its secret-store lookup in a bare
   `try { ... } catch { /* fall through */ }`. A decrypt failure
   (`X_CRED_ACCESS: tag_verify_fail`, emitted by the file-fallback on
   wrong-passphrase) was silently swallowed and replaced with
   `U_MISSING_CONFIG: provider_key_missing`. The user saw "no key" when the
   truth was "key is there, wrong passphrase".

### Fixes (`v0.3.7`)

- **Vault-aware `autoProvisionPassphrase`** (`src/platform/secrets/
  fileFallback.ts`) — before accepting a candidate passphrase from env /
  keychain / `.vault-key`, we try to decrypt the existing vault with it. If
  the vault exists and decryption fails, we raise
  `X_CRED_ACCESS / vault_locked` with a concrete recovery hint and
  **refuse to overwrite `.vault-key`**. First-run path (no vault yet) is
  unchanged.
- **Propagate `X_CRED_ACCESS`** (`src/providers/registry.ts`) — only
  `T_NOT_FOUND` (legitimate "key never stored") is benign now. Every other
  secret-store error is surfaced so users see the real problem.
- **Friendly REPL / CLI formatters** (`src/channels/cli/errorFormatCli.ts`
  new `formatBootError`, updated `src/observability/errorFormat.ts`) — map
  `U_MISSING_CONFIG`, `X_CRED_ACCESS / vault_locked`, `P_AUTH` to one-line
  Vietnamese/English sentences with a `→` hint pointing at the exact
  command. No more raw JSON blobs in the turn-init path.
- **REPL pre-warns** (`src/channels/cli/repl.ts`) — if
  `autoProvisionPassphrase` raises `vault_locked` at boot, the REPL prints
  the friendly warning immediately instead of waiting for the first chat
  turn to fail.
- **Key CLI handlers call auto-provision** (`src/key/cli.ts`) — `key list`,
  `key delete`, `key test` now each call `autoProvisionPassphrase` before
  touching the vault. Without this, any user whose passphrase lives in
  `.vault-key` saw `U_MISSING_CONFIG: missing_passphrase` on plain
  `nimbus key list`.

### Tests

- `tests/platform/secrets/upgradeRegression.test.ts` — 6 new unit/integration
  tests for the vault-guard + propagate path.
- `tests/e2e/binaryUpgradeSmoke.test.ts` — new PTY-adjacent smoke that spawns
  the compiled binary, replicates the exact user scenario, and asserts the
  output does NOT contain `U_MISSING_CONFIG: {` or `provider_key_missing`.
  Skipped when the binary isn't compiled (unit runs); run in CI + QA after
  `bun run compile:*`.

1898 tests green (3-OS matrix still required for tag).

### Honest QA retrospective (why v0.3.6 shipped broken)

QA for v0.3.6 smoked the Telegram adapter round-trip on Linux and claimed
green. The test set did not include "save key on v0.3.4-style binary, upgrade
binary, open new shell without env var, chat" — the exact flow that broke.
The binary-level smoke we added in this release is specifically designed to
catch "real workspace + real saved key + real new shell" before release. Bar
raised: **QA MUST execute the binary-upgrade scenario** for every alpha tag.

## [0.3.6-alpha] — 2026-04-16 — URGENT fix (Telegram hallucination: dead-code adapter → real wiring)

User repro flow (v0.3.5):

```
personal › tiếp tục kết nối tele đi e
  ⋯ writing telegram_bot.py
[ASK] Cho em ghi file telegram_bot.py? [Y/n/always/never] y
  ⋯ running: python3 -m pip install python-telegram-bot==21.6 ...
```

Agent wrote a Python bot script and pip-installed `python-telegram-bot` —
complete hallucination. Nimbus has a **built-in** Telegram adapter
(SPEC-803, shipped v0.3), but v0.3.5 never wired it into the runtime:

- No tool for the agent to invoke — so agent fell back to Write/Bash.
- `ChannelManager` existed only in tests; never instantiated in runtime.
- `channel.inbound` bus topic had zero subscribers — even if the adapter
  ran, inbound Telegram messages would vanish.
- No CLI command to configure token + allowlist.
- System prompt never mentioned the built-in adapter capability.

### Added (SPEC-808)

- **`ConnectTelegram` / `DisconnectTelegram` / `TelegramStatus` tools**
  (`src/tools/builtin/Telegram.ts`) — agent now has a real tool to call
  when the user says "kết nối telegram". Tools pull provider / model /
  registry / gate from a runtime bridge wired at REPL boot.
- **`ChannelRuntime` singleton** (`src/channels/runtime.ts`) — holds the
  `ChannelManager`, subscribes `channel.inbound` → runs a real `runTurn`
  with Telegram input as the user message, replies via
  `adapter.sendToChat()`. Per-chat serial queue prevents interleaved turns
  for the same user.
- **`nimbus telegram` subcommand** (`src/cli/commands/telegram.ts`) —
  `set-token` / `allow <id>` / `remove <id>` / `list` / `status` / `test` /
  `clear-token` / `reset --yes`. Token stored in vault at
  `service:telegram:botToken`; allowlist at `service:telegram:allowedUserIds`.
  The `test` subcommand calls Telegram `getMe` and reports `@username`.
- **`[CHANNELS]` system-prompt section** (`src/core/promptSections.ts`) —
  explicitly lists the built-in tools and states "NEVER create a
  `telegram_bot.py` or pip install `python-telegram-bot`". Hard-coded
  anti-hallucination guard.
- **TOOLS.md template note** — new workspaces get a "Channels" section in
  the tools manifest pointing at the built-in adapters.

### Security

- Bot token read from vault only; never logged, never in tool_result
  payloads, never in prompts. Tool display shows `@botUsername`.
- Inbound Telegram text kept in a `<channel_input source="telegram"
  trusted="false">…</channel_input>` wrapper so the agent treats it as
  untrusted (META-009 defense-in-depth over the channel). Closing-tag
  spoof attempts are neutralised via escape.
- All telegram-CLI paths call `autoProvisionPassphrase` before vault I/O
  so the list/status commands don't silently swallow decrypt failures
  (bug caught during smoke: previously `allow 42` would claim success
  but `list` showed empty).
- Unknown adapter IDs flowing through the inbound bridge are ignored; the
  existing SPEC-803 allowlist drop + security-event path is preserved.

### Verified

- 1876 unit tests + 15 HTTP tests green on Linux. New tests:
  - `tests/channels/telegram/config.test.ts` (11)
  - `tests/channels/runtime.test.ts` (6)
  - `tests/tools/telegram.test.ts` (6)
- Binary smoke: `nimbus telegram status / allow / remove / list / test /
  reset / set-token --token-stdin` round-trip against a fresh vault.

### Scope

- Daemon mode (bot stays online when REPL exits) → v0.4, documented in
  `status` output. Current behaviour: adapter lives inside the REPL
  process; clean shutdown on exit.
- Webhook transport → v0.3.1 (long-poll only in v0.3.6).
- Slack runtime bridge uses the same pattern — trivial follow-up once
  Telegram is stable.

## [0.3.5-alpha] — 2026-04-16 — URGENT patch (REPL exit after tool confirm)

User repro flow (v0.3.4):

```
░▒▓ nimbus ready  ·  personal  ·  gpt-5.4-mini
personal › paste telegram bot token
  ⋯ writing telegram.botToken
[ASK] Cho em ghi file telegram.botToken? [Y/n/always/never] y
  ✓ done
Được — em thử lại và đã lưu cấu hình vào telegram.botToken.

personal › root@hiepht:~/develop/nimbus-cli/nimbus-test#
```

After `✓ done` + assistant reply, the CLI silently exits back to the shell
mid-REPL. User cannot continue — catastrophic for a persistent AI OS.

### Fixed

- **REPL exits after tool confirm** (SPEC-825 v0.3) — root cause in
  `src/channels/cli/repl.ts::makeOnAsk`: the y/n prompt read the answer
  via `node:readline.createInterface({terminal:false})` on the shared
  stdin, then called `rl.close()`. `readline.close()` explicitly pauses
  the underlying stream (Node docs; preserved in Bun 1.3). Control returns
  to `slashAutocomplete.readLine()` which re-enables raw mode and attaches
  a `'data'` listener — but attaching a data listener does NOT auto-resume
  an *explicitly* paused stream. With no active I/O, Bun empties the event
  loop and exits with code 0. User sees the shell prompt.

  Minimal repro (pty-level): raw-mode handler → readline round-trip →
  raw-mode handler never receives bytes, process exits 0. Verified against
  Bun 1.3.12.

  Fix (two layers):
  1. Rewrite `makeOnAsk` to read the confirm token directly via a raw-mode
     `'data'` listener — identical mechanism to `slashAutocomplete`, no
     inner readline, no pause. Cleanup restores line mode on finish.
  2. Defence in depth: `slashAutocomplete.readLine()` now always calls
     `input.resume()` after setting raw mode + attaching its data listener,
     so the REPL recovers even if any other future code path leaves stdin
     paused.

  LoC delta: +32 / -16 across 2 files; 1 new test file (220 LoC).

### Added (regression tests)

- `tests/channels/cli/repl.confirmReplExit.test.ts` — 10 tests covering:
  - `parseConfirmAnswer` token mapping (y/yes/empty → allow; n/no/never
    → deny; always/a → always)
  - `makeOnAsk` resolves y/n/always/ctrl-c without pausing stdin
  - after `makeOnAsk` resolve, a downstream data listener still receives
    bytes on the same stream (REPL re-entry contract)
  - `slashAutocomplete.readLine()` always calls `input.resume()` on entry
  - `slashAutocomplete.readLine()` recovers from a pre-paused stream

### Known limitations

- Secondary i18n nit (label still shows English `⋯ writing ...` on
  `LANG=C.UTF-8` / WSL) is not fixed in this URGENT patch. Planned for
  v0.3.6: either default VN when recent turn contains VN content, or
  detect workspace SOUL language hint, or add `NIMBUS_LANG=vi` override.

## [0.3.4-alpha] — 2026-04-16 — URGENT patch (3 user-caught regressions from v0.3.3)

User repro flow: paste Telegram bot token → `[ASK] Cho em ghi file
telegram.botToken? [Y/n/always/never] y` → `✗ Tool failed — run with
--verbose for details.` → agent then hallucinates "em đã nhận token".

### Fixed

- **Bug A: `⋯ đang writing {path}` hybrid VN/EN label leak** (SPEC-826 v0.2) —
  the renderer hardcoded the VN `đang ` verb prefix in front of a label
  produced by the EN map whenever `detectLocale()` returned `'en'`. On
  servers with `LANG=C.UTF-8` (WSL default) the locale detects as `en` and
  the user saw the hybrid. Fix: moved the progressive verb inline into each
  label (VN `đang ghi file …`, EN `writing …`); renderer is now
  locale-agnostic. Added `MultiEdit`, `NotebookEdit`, `Ls`, and Bash `cmd`
  key aliases so registry-emitted names never hit the unknown-tool fallback.
  Propagated `args` on `tool_start` from `loop.ts` so the humanizer works
  even without a pre-computed `humanLabel`.
- **Bug B: confirm `y` → "Tool failed" generic error** (SPEC-825 v0.2) —
  two defects meant the `y` decision never led to actual execution:
  1. `gate.ts::decideByMode` consulted the session allow-cache only
     inside the `ruleDecision === 'ask'` branch. The common destructive-tool
     fallback path (`DESTRUCTIVE_TOOLS.has → 'ask'` with no matching rule)
     ignored the cache, so `rememberAllow` was ineffective.
  2. `loopAdapter.ts::execute` only called `rememberAllow` on the
     `'always'` branch. `'allow'` (user answered `y`) re-ran `runOnce`
     against a fresh gate, produced another `needs_confirm`, and the
     canonical error content surfaced as the generic "Tool failed — run
     with `--verbose`" (the `--verbose` dev hint in a user-facing CLI).
  Fixes: gate now probes the cache before the destructive fallback;
  loopAdapter populates the cache for both `'allow'` and `'always'` (they
  are session-equivalent in v0.3; v0.4 will split them via cross-session
  persistence). Renderer also extracts `errorCode` from `ToolResult.content`
  into `tool_end` so the friendly formatter picks a per-code sentence.
  Removed `--verbose` dev-hint from the default user-visible fallback.
- **Bug C: agent hallucinates "đã nhận token" after tool failure** (SPEC-124
  v0.2) — security-critical: user pasted a credential, Write tool failed,
  agent replied "Em đã nhận token, nhưng mình chưa thể lưu/kết nối…" — the
  user assumes the secret is stored when it is not. Fix: strengthened
  `CREDENTIAL_HANDLING_SECTION` in the system prompt with a new
  "TRUTHFULNESS ON TOOL FAILURE" hard-rule clause:
  - `isError: true` ⟹ credential is NOT saved
  - Forbid "đã nhận / saved / stored / got it" on any error tool_result
  - Forbid proposing user-paste-manually workaround
  - Re-read tool_result before claiming success (only `isError: false` counts)

### Added (regression tests)

- `tests/core/toolLabels.test.ts` — VN labels always start with `đang `,
  EN labels never contain `đang` (covers all 15 built-in + fallback).
  `LANG=C.UTF-8 → detectLocale === 'en'` pin.
- `tests/channels/cli/render.test.ts` — explicit Bug A repro (`đang writing`
  must NOT appear in EN path) + `MemoryTool` args-less composition.
- `tests/permissions/gate.test.ts` — `rememberAllow` converts destructive
  fallback `ask → allow` for Write / Bash / unknown-MCP-tool, no matching rule.
- `tests/tools/loopAdapter.test.ts` (new) — end-to-end onAsk flow with the
  real gate: `'allow'` actually re-executes the handler (Bug B pin);
  `'always'` remembered across invocations with same target; `'deny'`
  synthesizes `T_PERMISSION:user_denied` without handler call.
- `tests/core/prompts.test.ts` — anchor phrases "TRUTHFULNESS ON TOOL FAILURE",
  `credential is NOT saved`, `Do NOT say[…]đã nhận`, `paste the token manually`,
  `isError` are all present in the system prompt.

## [0.3.3-alpha] — 2026-04-16 — URGENT patch (5 regressions from v0.3.2)

### Fixed

- **`/cost` placeholder resurrected after dashboard rewrite** — both the REPL slash command
  (`src/channels/cli/repl.ts` `showCost`) and the CLI subcommand (`src/cli.ts` `case 'cost'`)
  had the stale "cost tracking arrives in v0.2" string instead of routing to the SPEC-701
  aggregator. Replaced with `aggregate(wsId, window)` → `renderRollup()`. Added
  `src/cli/commands/cost.ts` to keep user-facing CLI arg parsing (`--today|--week|--month
  [--by session|provider|day] [--json]`) isolated from the core aggregator.
- **Markdown render lost on compiled binary** — `createRenderer()` used `process.stdout.isTTY`
  for the TTY flag, which Bun's `--compile` target under-reported in some terminal emulators,
  causing `flushAssistant()` to skip the markdown re-render. Added `TERM`-based fallback plus
  a `NIMBUS_FORCE_MARKDOWN=1` escape hatch so the styled ANSI path fires whenever the user
  is actually in an interactive terminal.
- **Welcome screen missing on boot** — root cause was the 1-line compact variant picked for
  any reopen within 1 hour (`STALE_SECONDS = 3600`). Visually indistinguishable from the
  prompt row, users perceived no banner at all. Narrowed to 5 minutes (genuinely rapid
  reconnect window) so the prominent full mascot banner renders on nearly every boot.
- **Slash legend duplicated across keystrokes** — the partial-redraw path in
  `slashAutocomplete.ts` invoked `diffAndWrite` wrapped in `SAVE_CURSOR/RESTORE_CURSOR`, but
  `diffAndWrite` moved cursor UP by `prev.length` from the saved (prompt) row — into
  scrollback, NOT onto the old dropdown rows. Meanwhile the outer redraw's `CLEAR_BELOW`
  already wiped the prior dropdown, so the diff math was computing against ghost state.
  Replaced with a clean full-frame paint: `\n` + each row prefixed `\r\x1b[2K`, then cursor
  up + forward back to end-of-buffer. `diffAndWrite` retained in `slashRenderer.ts` for
  existing test coverage; just no longer used by the autocomplete.
- **`/clear` not dispatched** — registered `/clear` as a first-class slash command (category
  `session`) that calls `ctx.clearScreen` → `\x1b[2J\x1b[3J\x1b[H`. Previously `/clear`
  reached `dispatchSlash`, was not found in the registry, and emitted "Unknown command";
  some users reportedly pasted trailing content that bypassed parseSlash and the LLM
  treated it as natural-language text. Now explicit.

### Added (regression tests)

- `tests/channels/cli/slashCommands.test.ts` — `registerDefaultCommands` includes `/clear`;
  `/clear` routes to `clearScreen`, not LLM; `/cost` routes to `showCost`, not placeholder.
- `tests/channels/cli/slashAutocomplete.test.ts` — legend appears at most once in the last
  render frame after typing `/`, `/h`, `/he`.
- `tests/cli/commands/cost.test.ts` — `runCost` with no workspace exits 2 and does NOT emit
  the v0.2 placeholder; with workspace, renders `Cost — Today`; `--json` emits valid JSON.
- `tests/channels/cli/welcome.test.ts` — adjusted "compact <1h gap" tests to 5-minute
  threshold matching the new `STALE_SECONDS`.

### Changed

- `package.json` version `0.3.2-alpha` → `0.3.3-alpha`; matching strings in `src/cli.ts`
  and `src/cli/commands/doctor.ts`.

## [0.2.8-alpha] — 2026-04-16

### Fixed

- **Streaming blank-screen (Fix 1)** — assistant text deltas are now written to stdout
  immediately as they arrive (`output.write(ch.delta.text)` inline in the chunk handler)
  so the user sees output character-by-character. On `message_stop`, if the buffered text
  contains Markdown syntax *and* the output is a TTY, the renderer cursor-ups the streamed
  lines (`\x1b[NF\x1b[J`) and re-emits the full buffer through `renderMarkdown()` for styled
  ANSI output. Non-TTY or plain-text output just appends a trailing newline — no re-render,
  no escape sequences. Helper `countNewlines()` tracks newlines streamed so the cursor-up
  count is exact.
- **[PLAN] echo suppressed (Fix 2)** — `plan_announce` and `spec_announce` events no longer
  write anything to stdout. The model still receives the full `[INTERNAL_PLAN]` block via the
  system prompt (SPEC-105 extension, v0.2.7). User-visible pre-announcement was noise.
  Both event handlers now emit a `logger.debug` line for audit only.

### Changed

- `createRenderer()` now accepts either the legacy `(s: string) => void` write function **or**
  a new `RendererOutput` object `{ write, isTTY? }` so tests can inject a mock stream with
  `isTTY` control without touching `process.stdout`.

## [0.2.7-alpha] — 2026-04-16

### Added

- **CLI Markdown rendering** — assistant text is now buffered during streaming and
  rendered as styled ANSI output on turn completion (`src/channels/cli/markdownRender.ts`).
  Headings → bold cyan; bold/italic/codespan inline styles; unordered/ordered lists with `•`
  and `N.` markers; nested lists with indentation; code fences with `[lang]` label and cyan
  body; blockquotes with `│ ` prefix; horizontal rules. Plain text with no Markdown syntax
  returns unchanged (fast path via `hasMarkdownSyntax`).
- **`ChannelCapabilities`** interface + **`NativeFormat`** type added to `ChannelAdapter.ts`.
  CLI channel declares `nativeFormat: 'ansi'`; future bot channels declare their own format
  (`telegram-html`, `slack-mrkdwn`, `markdown`).
- **`marked`** npm dependency added (v18).

### Added

- **`install.sh`** — one-shot POSIX installer (`curl -fsSL …/install.sh | sh`).
  Detects OS + arch (linux-x64, linux-arm64, darwin-x64, darwin-arm64), fetches
  the latest GitHub release binary, verifies SHA256SUMS when available, installs
  to `~/.nimbus/bin/nimbus`, and adds PATH to bashrc/zshrc/fish config.
  Supports `-y`/`--force` for non-interactive CI installs and `--uninstall` for
  clean removal. POSIX sh — works on dash, bash, zsh.
- README "Install" section updated with one-line `curl | sh` command, options
  table, and Windows note.

## [0.2.3-alpha] — 2026-04-16

### Fixed

- **P_AUTH on upgrade (root cause)** — `diagnoseVault()` now runs at startup before REPL boot.
  If vault decrypt fails (e.g., passphrase mismatch after v0.2.1→v0.2.2 upgrade), an interactive
  recovery prompt guides the user to re-enter their key inline. Non-TTY prints actionable hint.
  `NIMBUS_SKIP_DIAGNOSE=1` env var bypasses for CI / scripted installs.

### Added

- **`nimbus doctor`** — read-only health check: platform, Bun version, workspace, schema version,
  vault file + decrypt, .vault-key permissions. Exit 0 = all OK, 1 = issues found with fix hints.
- **`nimbus vault reset [--yes]`** — backup secrets.enc → secrets.broken-{ts}.enc, delete vault,
  re-provision passphrase, prompt for new API key inline. `--yes` required to confirm.
- **`nimbus vault status`** — single-line vault health (same as doctor's vault row).
- **`nimbus backup create [--out FILE]`** — tar.gz of workspaces/ + .vault-key (mode 0600).
  Unencrypted in v0.2.3 with clear WARNING; AES-GCM stream encryption deferred to v0.3.
- **`nimbus backup restore <file>`** — extract backup for manual inspection.
- **`nimbus backup list`** — list backups in ~/nimbus-backups/.
- **Auto-snapshot before vault reset** — secrets.enc copied to secrets.broken-{ISO_TS}.enc before
  any destructive vault operation (vault reset, recovery prompt repair path).
- **Upgrade detection banner** — on first boot after version change, prints "nimbus X → Y (upgraded)"
  + changelog highlights. Pinned to `~/.nimbus/installed-version` after successful boot.
- **`src/platform/secrets/diagnose.ts`** — read-only vault classifier returning typed `VaultStatus`.
  Never throws; classifies: missing_file, missing_passphrase, decrypt_failed, corrupt_envelope,
  schema_old, schema_newer.
- **`src/onboard/upgradeDetector.ts`** — reads/writes `~/.nimbus/installed-version` for version pin.
- **`src/onboard/recoveryPrompt.ts`** — per-reason recovery UX with TTY choice prompt.

## [0.2.2-alpha] — 2026-04-16

### Fixed

- **P_AUTH blocker** — `startRepl` now calls `autoProvisionPassphrase()` on boot so vault decrypt works
  in a fresh process after `nimbus init`. The missing passphrase was silently swallowed, causing
  `openaiCompat` to fall back to the `'sk-unused'` sentinel and OpenAI to return 401.
- **Remove `'sk-unused'` sentinel** — `createOpenAICompatProvider` now throws `U_MISSING_CONFIG` with
  an actionable hint when no API key is available, instead of silently sending an invalid key.
  Ollama (local, keyless) is exempted via `endpoint !== 'ollama'` guard.
- **Narrow catch blocks in repl.ts** — `lazyProvider` no longer swallows `U_MISSING_CONFIG` and
  `X_CRED_ACCESS` errors from `resolveProviderKey`; only `T_NOT_FOUND` (key not stored yet) is
  silently suppressed. Real errors now surface to the user as readable messages.

### UX

- **`nimbus init` flows into REPL** — after completing init, the session starts automatically.
  Use `--no-chat` (or `--no-prompt`) to skip REPL entry for CI/scripted installs.
- **Slash command autocomplete dropdown** — type `/` in the REPL to see a live-filtered dropdown
  with ↑↓ navigation, Tab to complete, Esc to dismiss. Non-TTY terminals fall back gracefully.
  (Implementation was already present in v0.2.1; wiring is now confirmed correct.)

## [0.1.0-alpha] — 2026-04-15

First alpha release of nimbus-os — AI OS cá nhân đa năng với Runtime SDD differentiator.

### Highlights

- **AI OS đa năng cho mọi user** — chat, research, planning, mail, file, web, code, life management
- **🌟 Runtime SDD differentiator** — agent tự generate mini-spec (5 sections) từ user intent → display inline FYI → execute autonomously. Structured planning vs reactive agents.
- **Multi-provider từ ngày 1** — Anthropic + OpenAI-compatible (Groq/DeepSeek/Ollama/vLLM/Azure/LiteLLM/custom)
- **SOUL/IDENTITY/MEMORY/TOOLS/DREAMS** — persistent personality + memory cross-session (OpenClaw-inspired)
- **5-layer safety** — permission modes + bash tier-1 security (12 rules + 19 bypass + 13 T16 traces) + path validator + network policy + sandbox-ready
- **Cost-aware** — per-turn ledger + 5-provider 2026 price table + USD dashboard
- **Secure key management** — masked TTY prompt + OS keychain + per-workspace isolation + priority chain (CLI > env > secrets > config)

### Implementation (479/479 tests pass)

| Module | Tests | Spec |
|--------|-------|------|
| scripts/spec/ — SDD dev tooling | — | SPEC-911 |
| observability/ — errors + logger + audit + cost | — | SPEC-119, SPEC-701 |
| platform/ — paths/secrets/shell/signals/notifier | 39 | SPEC-151, SPEC-152 |
| ir/ + providers/ — Canonical IR + Anthropic + OpenAI-compat | 94 | SPEC-201-203 |
| core/ — workspace/session/loop/autonomy/Runtime SDD | 170 | SPEC-101-110, 118, 119 |
| permissions/ — 3 modes + rules + matcher + pathValidator + gate | 68 | SPEC-401, SPEC-402 |
| storage/config + cost/ — 6-layer config + ledger + dashboard | 33 | SPEC-501, SPEC-701 |
| channels/cli + onboard/ — REPL + init wizard | 30 | SPEC-801, SPEC-901 |
| tools/ + bash security — 7 builtin + tier-1 | 150 | SPEC-301-304, SPEC-303 |
| key management — wizard + nimbus key CLI | 39 | SPEC-902 |

### Added

- `nimbus init` interactive wizard — workspace + SOUL.md + key (masked prompt)
- `nimbus` REPL — interactive AI OS session
- `nimbus key {set,list,delete,test}` — multi-provider key management
- `nimbus cost --today|week|month|--by` — usage dashboard
- 12 slash commands in REPL (`/help`, `/quit`, `/stop`, `/new`, `/switch`, `/workspaces`, `/soul`, `/memory`, `/provider`, `/model`, `/cost`, `/spec-confirm`)
- 7 built-in tools: Read, Write, Edit, Grep, Glob, Bash, Memory
- 12 bash tier-1 security rules (TR-1 → TR-12): rm-rf, curl|sh, subshells, interpreter -c, fork bomb, IFS/PATH/LD_PRELOAD injection, sudo, process substitution, sensitive paths, cloud metadata, persistence paths, audit tampering
- pwsh equivalents (TR-1P → TR-11P)
- SOUL injection vào system prompt với cache breakpoints (Anthropic prompt cache)
- Auto-plan detector với 3 heuristics (H1 cue word bilingual VN+EN / H2 tool count / H3 item scope)
- Environment snapshot (git + cwd + time + last failed tool)
- Runtime SDD generator (Haiku class, 5-section spec, high-risk auto-flag, background persist)
- Circuit breaker (3 consecutive errors → Y_CIRCUIT_BREAKER_OPEN)
- 3-tier cancellation (turn / call / process)

### Infrastructure

- 41 specs (6 META + 35 feature) với SDD workflow (spec-first + spec-anchored)
- `bun run spec` dev tooling (init/new/list/show/validate/index)
- CI matrix Win/macOS/Linux (GitHub Actions)
- TypeScript strict + Bun-native (no Node shims)
- Spec validator: 10 rules + frontmatter Zod + cycle detection

### Not yet (v0.2+)

- Skills system (bundled /skill commit/research/review, user skills)
- MCP (Model Context Protocol) integration
- Sub-agents + spawn + mailbox
- 6 full permission modes (`plan`, `auto`, `isolated`)
- Context compaction (micro + full 9-section summary)
- Full safety layer (content trust, injection detector, sandbox, audit chain)
- HTTP/WS + Slack + Telegram channels
- Background daemon (launchd/systemd/Windows Service)
- Browser automation (Playwright)
- Dreaming 3-phase memory consolidation
- RAG retrieval + OpenTelemetry

### Known limitations (v0.1-alpha)

- Local small LLMs (< 7B) tool-calling reliability variable — prefer Claude Sonnet/GPT-4o-mini/Llama-3.3-70b cho consistent behavior
- Windows shell.exe quoting edge cases may need follow-up
- SPEC-601 observability retention registration chưa wired với SPEC-701 cost ledger — cost ledger self-manages cho v0.1

### Contributors

- [@hiepht](https://github.com/hiepht) — project vision, architecture, plan, SDD workflow
- Team agents (Opus + Sonnet parallel): spec-writers, developers, reviewers, QA

### Inspirations

- [OpenClaw](https://github.com/openclaw/openclaw) — architecture + SOUL/MEMORY files pattern
- [Claude Code](https://claude.com/claude-code) — agentic loop + permission gate patterns
- [soul.md](https://github.com/aaronjmars/soul.md) — personality file quality standards
- [GitHub Spec Kit](https://github.com/github/spec-kit) — SDD workflow inspiration

---

*Thank you cho early testers. Issues: https://github.com/your-org/nimbus-os/issues*
