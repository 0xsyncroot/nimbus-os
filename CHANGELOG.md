# Changelog — nimbus-os

All notable changes to nimbus-os. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
