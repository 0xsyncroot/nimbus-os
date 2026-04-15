# nimbus-os

> **Personal AI OS** — an autonomous, soul-driven agent with cross-session memory.
> Bun + TypeScript, multi-provider, multi-channel, local-first, runs 24/7.

[![version](https://img.shields.io/badge/version-v0.1.0--alpha-orange)](https://github.com/0xsyncroot/nimbus-os/releases/tag/v0.1.0-alpha)
[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](./LICENSE)
[![bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.2-black)](https://bun.sh)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)
[![tests](https://img.shields.io/badge/tests-526%20passing-brightgreen)](./tests)
[![platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#platform-support)

nimbus-os is designed for **everyone** — not just developers. It is your
personal operating assistant: researcher, planner, writer, organizer,
communicator, and automator, with a consistent personality that carries
across sessions.

---

## Table of contents

- [Why nimbus-os](#why-nimbus-os)
- [What you can do with it](#what-you-can-do-with-it)
- [Architecture](#architecture)
- [Install & quick start](#install--quick-start)
- [Configuration](#configuration)
- [Providers](#providers)
- [Security model](#security-model)
- [Project status & roadmap](#project-status--roadmap)
- [Development](#development)
- [Platform support](#platform-support)
- [FAQ](#faq)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Contact](#contact)

---

## Why nimbus-os

Most AI assistants are either chatbots (reactive, no memory) or tightly-scoped
code tools. nimbus-os fills the gap in between:

| Capability | Typical chatbot | Typical coding agent | **nimbus-os** |
|------------|-----------------|----------------------|---------------|
| Long-term memory across sessions | ❌ | Partial (project only) | ✅ SOUL/IDENTITY/MEMORY markdown |
| General-purpose (not just code) | ✅ | ❌ | ✅ Research, planning, writing, life admin |
| Local-first, your data | ❌ Cloud | Mostly cloud | ✅ Runs on your machine |
| Multi-provider (Anthropic/OpenAI/local) | Usually one | Usually one | ✅ Anthropic + OpenAI-compat + local |
| Channel-agnostic (CLI, chat apps, HTTP) | Web only | IDE only | ✅ CLI today; Slack/Telegram/HTTP coming |
| Cost visibility per action | ❌ | ❌ | ✅ Per-turn ledger + provider price table |
| Destructive-action guard | — | Partial | ✅ 5-layer permission + bash tier-1 + path deny-list |
| Self-healing | ❌ | Partial | ✅ Deterministic policy per error class |

**Defining trait: runtime SDD.** Before non-trivial tasks the agent writes an
internal mini-spec (5 sections, ~100 words) as a structured thinking aid,
shows a one-line FYI, then executes — no per-turn user gate. A separate
permission layer protects destructive operations. You stay in control without
being interrupted.

---

## What you can do with it

- 🔬 **Research** — deep-dive a topic, summarize sources, compare options
- 📅 **Planning** — trips, projects, events, weekly schedules
- ✍️ **Writing** — draft, edit, translate, summarize
- 📁 **File & data triage** — rename, group, archive, deduplicate
- 📨 **Communication (via channels)** — email triage, calendar, messaging
- 🤖 **Code help** — refactor, review, tests, debugging
- 🧠 **Life admin** — reminders, expense logs, habit tracking
- 🌐 **Web automation** — form fill, booking, scraping *(v0.4 browser)*

Each workspace has a **SOUL.md** that defines how the agent talks and behaves.
See [`examples/souls/`](./examples/souls/) for ready-made templates
(daily-assistant, researcher, writer, software-dev) and
[`docs/soul-writing.md`](./docs/soul-writing.md) for the authoring guide.

---

## Architecture

```
Channels → WorkspaceManager → AgentLoop → CanonicalIR → Provider
                 ↓                ↓             ↓
           SOUL/MEMORY      Permission    Safety/Obs/Cost
                                              ↓
                                         Platform (Win/Linux/macOS)
```

- **Channels** — CLI today; HTTP/WS, Slack, Telegram, iMessage, Signal, WhatsApp on roadmap
- **Workspace** — SOUL.md + IDENTITY.md + MEMORY.md + TOOLS.md + sessions (JSONL)
- **Agent loop** — 3-tier cancellation, plan detector, event bus
- **Canonical IR** — provider-agnostic message/block format (Anthropic & OpenAI adapt to it)
- **Permissions** — 3 modes (readonly / default / bypass), rule parser, bash tier-1 security, path deny-list
- **Platform abstraction** — paths, shell, signals, OS keychain / AES-GCM vault

More detail:
- Full architecture spec: [`specs/00-meta/META-001-architecture.spec.md`](./specs/00-meta/META-001-architecture.spec.md)
- Canonical IR: [`specs/00-meta/META-004-canonical-ir.spec.md`](./specs/00-meta/META-004-canonical-ir.spec.md)
- Threat model: [`specs/00-meta/META-009-threat-model.spec.md`](./specs/00-meta/META-009-threat-model.spec.md)

---

## Install & quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — `curl -fsSL https://bun.sh/install | bash`
- An API key from any supported provider *(skip if using local Ollama/vLLM)*

### Option A — run from source

```bash
git clone https://github.com/0xsyncroot/nimbus-os.git
cd nimbus-os
bun install
bun run start init                    # wizard: name, provider, model
bun run start                         # enter REPL
```

### Option B — compile a single binary

```bash
bun run compile:linux-x64             # or :darwin-arm64 / :windows-x64
./dist/nimbus-linux-x64 init
./dist/nimbus-linux-x64
```

### First chat

Inside the REPL, talk naturally:

```
> summarize the last 5 emails in my inbox
> research best 14" laptops under $1500, compare top 5
> tidy ~/Downloads and group screenshots into a folder
> schedule a meeting with Alice next week
```

The agent plans internally (runtime SDD), shows a one-line FYI, then acts.
Destructive actions go through the permission gate and prompt for confirmation.

Slash commands: `/new`, `/sessions`, `/soul`, `/memory`, `/provider`, `/model`,
`/mode readonly|default|bypass`, `/cost`, `/stop`. Full list in
[`docs/getting-started.md`](./docs/getting-started.md).

---

## Configuration

### API keys — stored encrypted

```bash
# Anthropic (official endpoint)
nimbus key set anthropic

# OpenAI
nimbus key set openai

# OpenAI-compatible w/ custom baseUrl (auto-aligns workspace defaults)
nimbus key set openai --base-url https://api.groq.com/openai/v1
nimbus key set openai --base-url http://localhost:9000/v1       # vLLM / Ollama
```

Keys are held in an AES-GCM vault at
`~/.local/share/nimbus/vault.jsonl` (or `%LOCALAPPDATA%\nimbus\vault.jsonl`).
In v0.1.0 the passphrase is supplied via `NIMBUS_VAULT_PASSPHRASE`; native OS
keychain integration lands in v0.1.1.

### Workspace data

By default nimbus writes to platform-standard directories:

| OS | Path |
|----|------|
| Linux | `~/.local/share/nimbus/workspaces/{id}` |
| macOS | `~/Library/Application Support/nimbus/workspaces/{id}` |
| Windows | `%LOCALAPPDATA%\nimbus\workspaces\{id}` |

Each workspace has `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`,
`DREAMS.md` and a `sessions/` directory. Everything is plain markdown or
append-only JSONL — inspectable, editable, and greppable.

### SOUL.md — agent personality

```markdown
---
schemaVersion: 1
name: my-assistant
created: 2026-04-15
---

# Identity
I am your day-to-day assistant — friendly, concrete, cautious with anything
irreversible. ...

# Values
- Confirm before any action that cannot be undone
- State uncertainty explicitly
- ...

# Communication Style
- Voice: warm, concise
- Language: Vietnamese primary, English for technical terms

# Boundaries
- Will NOT: pay online, read .env / .ssh, send email without confirmation
- Will only if explicit: mimic another author's style
```

Full authoring guide: [`docs/soul-writing.md`](./docs/soul-writing.md).

---

## Providers

| Provider | Kind | baseUrl | Notes |
|----------|------|---------|-------|
| Anthropic | `anthropic` | default | Prompt caching (explicit), vision, extended thinking |
| OpenAI | `openai-compat` | default | `max_completion_tokens` auto-routed for o1 / gpt-5.x |
| Groq | `openai-compat` | `https://api.groq.com/openai/v1` | Fast + free tier |
| DeepSeek | `openai-compat` | `https://api.deepseek.com/v1` | Low cost |
| Ollama | `openai-compat` | `http://localhost:11434/v1` | Local, no key |
| vLLM / any OpenAI-compat | `openai-compat` | your URL | Self-hosted |

Switch any time: `/provider <id>` inside the REPL. More details:
[`docs/providers.md`](./docs/providers.md).

---

## Security model

nimbus-os has **full access to filesystem, shell, network, and code
execution**. It is designed for single-user local use only. Defenses:

1. **Permission modes** — `readonly` (no writes), `default` (confirm on write/bash), `bypass` (trust-mode, opt-in)
2. **Rule parser** — allow / deny lists with glob + regex (e.g., `Bash(git:*)`, `Read(~/.ssh/*)` denied)
3. **Bash tier-1 security** — blocks `rm -rf /`, `curl | sh`, fork bombs, LD_PRELOAD, DNS exfil, etc. 12 rules + 19 bypass tests + 13 T16 traces
4. **Path validator** — `.env`, `.ssh/`, credential files denied by default (case-insensitive)
5. **Encrypted vault** — API keys never in plaintext on disk
6. **Audit log** — every tool call + security event appended to `events.jsonl`

Please read [`docs/security.md`](./docs/security.md) before enabling `bypass`
mode or connecting remote channels.

---

## Project status & roadmap

**v0.1.0-alpha** *(this release)* — MVP foundation: CLI REPL, Anthropic +
OpenAI-compat + local providers, workspace / session / SOUL, permissions,
bash security, cost tracking, 526 unit tests.

| Release | Focus | Target |
|---------|-------|--------|
| v0.2 | Skills, MCP, full permission modes, compaction, budget enforcement, i18n | ~6 weeks |
| v0.3 | Sub-agents, HTTP/WS + Slack + Telegram, auth, CLI dashboard | ~5 weeks |
| v0.4 | Daemon (24/7), browser automation, iMessage, web dashboard + PWA | ~5 weeks |
| v0.5 | Dreaming (sleep-based memory), RAG, Signal + WhatsApp, OTEL, signed binaries | ~6 weeks |

Source of truth: [`specs/_index.md`](./specs/_index.md).

---

## Development

nimbus-os is built using **Spec-Driven Development**. Every feature has a spec
in [`specs/`](./specs/) *before* any code is written. Spec + code must land in
the same commit.

```bash
bun run spec list                     # list all specs with status
bun run spec show SPEC-101            # view a spec
bun run spec validate                 # verify 6 elements + link resolution
bun run spec new SPEC-XXX             # scaffold a new spec

bun test                              # run unit tests
bun run typecheck                     # strict TS, no any
bun run lint                          # eslint
bun run format                        # prettier
```

Commit format: `[SPEC-XXX] imperative subject`. More in
[`CLAUDE.md`](./CLAUDE.md).

### Repo layout

```
nimbus-os/
├── src/            # implementation (TS strict, Bun-native)
├── specs/          # SDD artifacts — source of truth
├── tests/          # unit tests (mirrors src/ layout)
├── docs/           # user-facing documentation
├── examples/       # SOUL.md templates
├── scripts/        # dev tooling (bun run spec …)
├── dist/           # compiled binaries (git-ignored)
└── CHANGELOG.md    # release notes
```

---

## Platform support

| Platform | Status |
|----------|--------|
| Linux x64 (glibc) | ✅ v0.1 — compiled binary verified |
| Linux arm64 | ✅ v0.1 — compiles, testing in progress |
| macOS arm64 (M-series) | ✅ v0.1 — compiles; CI coverage v0.2 |
| macOS x64 | ✅ v0.1 — compiles |
| Windows x64 (10 1809+) | ✅ v0.1 — compiles, native (no WSL required) |

---

## FAQ

**Is my data sent anywhere?**  
Only to the LLM provider you configure. Workspace data stays local. No
telemetry, no phone-home.

**Can I use this offline?**  
Yes — pair it with Ollama or vLLM. No API key required.

**Why PolyForm Noncommercial and not MIT?**  
Personal, research, hobby, and nonprofit use is free. Commercial use (paid
products, hosted services, internal enterprise tooling) requires a separate
license — see [License](#license) below.

**How does it differ from OpenClaw / Claude Code?**  
OpenClaw inspired the SOUL/IDENTITY/MEMORY/DREAMS shape. Claude Code inspired
the agentic loop and safety patterns. nimbus-os combines both plus
multi-provider, runtime SDD, cross-session personality, and is aimed at
general users, not only developers.

**What about mobile?**  
v0.3 adds Telegram/Slack channels that give you mobile access via existing
apps. v0.4 adds a PWA web dashboard. Native iOS/Android only if the first two
are insufficient.

---

## License

nimbus-os is released under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**.

### ✅ Free for personal and noncommercial use

- Personal projects, research, education, hobby
- Charitable, educational, public safety, and government institutions
- Evaluating nimbus-os inside your company

### 💼 Commercial use requires a commercial license

Hosting nimbus-os as a service, bundling it into a product you sell,
redistributing it commercially, or using it for profit-generating operations
at a for-profit organization beyond personal/evaluation scope are **not
permitted** under the PolyForm license.

Contact the author for commercial terms — licenses are available at
reasonable rates for startups, larger organizations, and custom deployments.

📧 **Commercial license inquiries**: work.hiepht@gmail.com
(subject: `nimbus-os commercial license inquiry`)

---

## Acknowledgments

Patterns and inspiration:

- [OpenClaw](https://github.com/openclaw/openclaw) — SOUL/IDENTITY/MEMORY/DREAMS, daemon, channels
- [Claude Code](https://claude.com/claude-code) — agentic loop, bash security, compaction
- [soul.md](https://github.com/aaronjmars/soul.md) — personality layering
- [Spec Kit](https://github.com/github/spec-kit) — SDD methodology
- [Bun](https://bun.sh) — runtime that made a single-binary personal AI OS practical

---

## Contact

- **Author**: Hiep Hoang Trung
- **Email**: [work.hiepht@gmail.com](mailto:work.hiepht@gmail.com)
- **Issues**: [github.com/0xsyncroot/nimbus-os/issues](https://github.com/0xsyncroot/nimbus-os/issues)
- **Commercial licensing**: work.hiepht@gmail.com (subject: `nimbus-os commercial license inquiry`)
