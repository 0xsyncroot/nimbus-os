---
id: META-010
title: Naming conventions — files, identifiers, specs, commits
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
layer: meta
depends_on: []
---

# Naming Conventions

## 1. Purpose

Single source of truth for all naming in nimbus-os. Enforced via lint rules where possible.

## 2. Contract

### 2.1 Files (code)

- **TS source**: `camelCase.ts` (e.g., `workspaceStore.ts`, `bashSecurity.ts`)
- **Type-only**: `camelCase.ts` with suffix allowed (`workspaceTypes.ts`)
- **Tests**: mirror source with `.test.ts` (e.g., `workspaceStore.test.ts`)
- **No kebab-case for code files**: `workspace-store.ts` FORBIDDEN

Exceptions:
- Framework-required: `next.config.ts`, `vitest.config.ts`, etc. (none in nimbus)
- Docs: kebab-case OK (`getting-started.md`)

### 2.2 Files (workspace data / markdown)

- **ALL UPPERCASE**: `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`, `AGENTS.md`, `DREAMS.md`, `CLAUDE.md`, `README.md`, `LICENSE`
- **Reason**: signals "this is a contract file, edit carefully"

### 2.3 Files (specs)

- `SPEC-XXX-kebab-name.spec.md` (e.g., `SPEC-101-workspace-lifecycle.spec.md`)
- `META-XXX-kebab-name.spec.md`
- `MOD-XX-kebab-name.spec.md`
- XXX = 3-digit, module-aligned:
  - 001-099: meta
  - 101-199: 10-core
  - 151-199: 15-platform
  - 201-299: 20-ir-providers
  - 301-399: 30-tools
  - 401-499: 40-permissions
  - 501-599: 50-storage
  - 601-699: 60-observability
  - 701-799: 70-cost
  - 801-899: 80-channels
  - 901-999: 90-onboard + spec-tool (901-910 onboard, 911-999 meta-tooling)

### 2.4 Code identifiers

- **Types / interfaces / classes**: `PascalCase` (`Workspace`, `CanonicalBlock`, `NimbusError`)
- **Enum names**: `PascalCase` (`ErrorCode`, `PermissionMode`)
- **Enum values**: `SCREAMING_SNAKE_CASE` (`ErrorCode.P_NETWORK`)
- **Functions / methods**: `camelCase` (`loadWorkspace`, `classify`)
- **Variables / parameters**: `camelCase` (`sessionId`, `workspaceMeta`)
- **Constants (module-level)**: `SCREAMING_SNAKE_CASE` (`DEFAULT_MODEL`, `MAX_TOKENS`)
- **Booleans**: prefix `is/has/should/can` (`isReadOnly`, `hasPermission`)

### 2.5 Wire format / IR

- **Internal (code)**: `camelCase` (`toolUseId`, `cacheRead`)
- **Anthropic wire**: `snake_case` (`tool_use_id`, `cache_read_input_tokens`) — adapter converts
- **OpenAI wire**: `snake_case` (`tool_call_id`) — adapter converts
- Storage JSONL: always `camelCase` (our internal format, adapters already normalized)

### 2.6 Commands

- **CLI**: `nimbus <verb> <object>` — kebab-case compound verbs
  - `nimbus init`, `bun run spec validate`, `nimbus cost --today`
  - `nimbus memory promote-explain` (compound verb hyphenated)
- **Slash (REPL + channels)**: `/verb [args]` — lowercase, no hyphens (short form)
  - `/compact`, `/mode auto`, `/soul edit`

### 2.7 Version labels

- **Format**: `v0.1`, `v0.2`, ..., `v0.5` (NOT `Phase 1-5`, NOT `1.0.0`)
- **v0.1 MVP** is the only singular tag: use `v0.1 MVP` in prose, `v0.1` in tables.
- `v1.0+` for post-v0.5 (future mobile native app phase).

### 2.8 Prose terminology

- **"sub-agent"** (hyphenated) for prose; `Agent`, `AgentTool` for class/folder
- **"nimbus-os"** (kebab, lowercase) for project; `nimbus` for binary/command
- **"workspace"** lowercase in prose; `Workspace` type
- **"channel"** for messaging adapter; `ChannelAdapter` interface
- **Don't use**: "teammate" (OpenClaw reserved), "bot" (too colloquial)

### 2.9 Commits

- Format: `[SPEC-XXX] imperative subject, ≤60 chars`
- Examples:
  - `[SPEC-101] implement workspace lifecycle CRUD`
  - `[META-003] refine ErrorCode enum`
  - `[SPEC-303] add fork bomb detection to bashSecurity`
- Body (if needed): bullets of what + why, not how

### 2.10 Tests

- `describe('SPEC-XXX: <short title>', ...)` — trace test back to spec
- `test('should <behavior>', ...)` — behavior-first
- Fixtures: `tests/fixtures/{moduleName}/`

## 3. Rationale

- **camelCase for TS files**: matches modern TS ecosystem (Bun examples, Vite, etc.)
- **UPPERCASE for markdown contracts**: visual signal "this is data/contract not code"
- **SPEC-XXX 3-digit module-aligned**: `SPEC-301` immediately tells reader "tools module" without file inspection
- **toolUseId internal camelCase**: consistent storage + IR; adapters handle wire format
- **Imperative commit subject**: industry standard (Angular, Conventional Commits)

## 4. Consumers

Every spec. Every code file. Every commit.

## 5. Evolution Policy

Naming rule changes require:
1. Migration plan for existing code (codemod or manual)
2. Update lint rules simultaneously
3. Changelog entry

## 6. Changelog

- 2026-04-15 @hiepht: initial + approve
