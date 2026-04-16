# Changelog — nimbus-os

All notable changes to nimbus-os. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

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
