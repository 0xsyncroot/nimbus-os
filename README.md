# nimbus-os

> Personal AI OS — autonomous, soul-driven agent with cross-session memory.
> Bun + TypeScript, multi-provider, local-first, runs 24/7.

[![version](https://img.shields.io/github/v/release/0xsyncroot/nimbus-os?include_prereleases&color=orange)](https://github.com/0xsyncroot/nimbus-os/releases)
[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](./LICENSE)
[![bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A51.2-black)](https://bun.sh)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.json)
[![CI](https://github.com/0xsyncroot/nimbus-os/actions/workflows/ci.yml/badge.svg)](https://github.com/0xsyncroot/nimbus-os/actions/workflows/ci.yml)

nimbus-os runs on your machine and helps with anything you would normally hand
to a personal assistant: research, planning, writing, file/data triage,
communication, life admin, code help, and light automation. Each workspace
has a SOUL (personality) and persistent MEMORY that carry across sessions,
giving you a consistent, opinionated assistant rather than a blank chatbot.

---

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Install & quick start](#install--quick-start)
- [Configuration](#configuration)
- [Providers](#providers)
- [Security](#security)
- [Development](#development)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Overview

**What it is**

- A local-first, long-running, single-user AI agent with shell / filesystem / network access.
- Workspaces are plain markdown (`SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`) plus append-only JSONL sessions — inspectable, editable, greppable.
- Ships as a single compiled binary per platform (Linux / macOS / Windows).

**Defining trait — runtime SDD.** Before non-trivial tasks the agent writes an
internal mini-spec (5 sections, ~100 words) as a structured thinking aid, shows
a one-line FYI, then executes. A separate permission layer protects destructive
operations. You stay in control without being interrupted.

**What you can do with it**

- 🔬 Research — deep-dive a topic, summarize sources, compare options
- 📅 Planning — trips, projects, events, schedules
- ✍️ Writing — draft, edit, translate, summarize
- 📁 File & data triage — rename, group, archive, deduplicate
- 🤖 Code help — refactor, review, tests, debugging
- 🧠 Life admin — reminders, expense logs, habit tracking

See [`examples/souls/`](./examples/souls/) for ready-made personalities and
[`docs/soul-writing.md`](./docs/soul-writing.md) for the authoring guide.

---

## Architecture

```
Channels → WorkspaceManager → AgentLoop → CanonicalIR → Provider
                 ↓                ↓             ↓
           SOUL/MEMORY       Permission    Safety/Obs/Cost
                                              ↓
                                         Platform (Win/Linux/macOS)
```

- **Workspace** — SOUL.md + IDENTITY.md + MEMORY.md + TOOLS.md + sessions (JSONL)
- **Agent loop** — 3-tier cancellation, plan detector, event bus
- **Canonical IR** — provider-agnostic message/block format; Anthropic and OpenAI-compat adapt to it
- **Permissions** — 3 modes (readonly / default / bypass), rule parser, bash tier-1 security, path deny-list
- **Platform** — detection, paths, shell, signals, AES-GCM vault

Spec-level detail:
[`specs/00-meta/META-001-architecture.spec.md`](./specs/00-meta/META-001-architecture.spec.md) •
[`specs/00-meta/META-004-canonical-ir.spec.md`](./specs/00-meta/META-004-canonical-ir.spec.md) •
[`specs/00-meta/META-009-threat-model.spec.md`](./specs/00-meta/META-009-threat-model.spec.md).

---

## Install & quick start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.2 — `curl -fsSL https://bun.sh/install | bash`
- An API key from any supported provider *(skip if using local Ollama / vLLM)*

### From source

```bash
git clone https://github.com/0xsyncroot/nimbus-os.git
cd nimbus-os
bun install
bun run start init       # wizard: name, provider, model
bun run start            # enter REPL
```

### Compiled binary

Pre-built binaries for Linux, macOS, and Windows are attached to every release
on the [Releases page](https://github.com/0xsyncroot/nimbus-os/releases).

To build locally:

```bash
bun run compile:linux-x64      # or :linux-arm64 / :darwin-x64 / :darwin-arm64 / :windows-x64
./dist/nimbus-linux-x64 init
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
`/mode readonly|default|bypass`, `/cost`, `/stop`.
Full list: [`docs/getting-started.md`](./docs/getting-started.md).

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
`~/.local/share/nimbus/vault.jsonl` (or the platform-equivalent).
In v0.1.0 the passphrase is supplied via `NIMBUS_VAULT_PASSPHRASE`; native OS
keychain integration is on the near-term roadmap.

### Workspace data

| OS | Path |
|----|------|
| Linux | `~/.local/share/nimbus/workspaces/{id}` |
| macOS | `~/Library/Application Support/nimbus/workspaces/{id}` |
| Windows | `%LOCALAPPDATA%\nimbus\workspaces\{id}` |

Each workspace contains `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`,
`DREAMS.md`, and a `sessions/` directory.

### SOUL.md example

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
| Groq | `openai-compat` | `https://api.groq.com/openai/v1` | Fast, free tier |
| DeepSeek | `openai-compat` | `https://api.deepseek.com/v1` | Low cost |
| Ollama | `openai-compat` | `http://localhost:11434/v1` | Local, no key |
| vLLM / any OpenAI-compat | `openai-compat` | your URL | Self-hosted |

Switch any time with `/provider <id>` inside the REPL. More:
[`docs/providers.md`](./docs/providers.md).

---

## Security

nimbus-os has full access to filesystem, shell, network, and code execution.
It is designed for single-user local use. Defenses:

1. **Permission modes** — `readonly`, `default` (confirm on write/bash), `bypass` (opt-in).
2. **Rule parser** — allow / deny lists with glob + regex.
3. **Bash tier-1 security** — blocks `rm -rf /`, `curl | sh`, fork bombs, LD_PRELOAD, DNS exfil, and related patterns.
4. **Path validator** — `.env`, `.ssh/`, credential files are denied by default (case-insensitive).
5. **Encrypted vault** — API keys never stored in plaintext.
6. **Audit log** — every tool call + security event appended to `events.jsonl`.

Read [`docs/security.md`](./docs/security.md) before enabling `bypass` mode or
exposing nimbus to remote channels.

---

## Development

nimbus-os is built using **Spec-Driven Development**. Every feature has a spec
in [`specs/`](./specs/) before any code is written; spec and code land in the
same commit.

```bash
bun run spec list                     # list specs
bun run spec show SPEC-101            # view a spec
bun run spec validate                 # verify 6 elements + link resolution
bun run spec new SPEC-XXX             # scaffold a new spec

bun test                              # run unit tests
bun run typecheck                     # strict TS, no any
bun run lint                          # eslint
bun run format                        # prettier
```

Commit format: `[SPEC-XXX] imperative subject`. More:
[`CLAUDE.md`](./CLAUDE.md).

### Repo layout

```
nimbus-os/
├── src/            # implementation (TS strict, Bun-native)
├── specs/          # SDD artifacts — source of truth
├── tests/          # unit tests (mirror of src/)
├── docs/           # user-facing documentation
├── examples/       # SOUL.md templates
├── scripts/        # dev tooling (bun run spec …)
└── dist/           # compiled binaries (git-ignored)
```

Issues and pull requests are welcome via the
[Issues](https://github.com/0xsyncroot/nimbus-os/issues) and
[Pull Requests](https://github.com/0xsyncroot/nimbus-os/pulls) pages.

---

## License

nimbus-os is released under the
[**PolyForm Noncommercial License 1.0.0**](./LICENSE).

- **Personal, research, hobby, educational, and nonprofit use** is free.
- **Commercial use** (hosting nimbus as a service, bundling into a product
  you sell, internal production use at a for-profit organization beyond
  evaluation scope) is **not permitted** under this license and requires
  permission from the author. Open an issue tagged `commercial-license` to
  get in touch.

---

## Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) — SOUL/IDENTITY/MEMORY/DREAMS, daemon, channels
- [Claude Code](https://claude.com/claude-code) — agentic loop, bash security, compaction
- [soul.md](https://github.com/aaronjmars/soul.md) — personality layering
- [Spec Kit](https://github.com/github/spec-kit) — SDD methodology
- [Bun](https://bun.sh) — runtime that makes a single-binary personal AI OS practical
