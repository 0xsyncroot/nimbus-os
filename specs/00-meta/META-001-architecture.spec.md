---
id: META-001
title: Architecture overview — layered design with 3-tier hierarchy
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
layer: meta
depends_on: []
---

# Architecture Overview

## 1. Purpose

Define the binding architectural layering, data flow, and hierarchy that every nimbus-os spec must conform to. Every other spec references this as the authoritative architecture contract.

## 2. Contract

### 2.1 Three-tier Hierarchy

```
Workspace   — project scope: SOUL/IDENTITY/MEMORY/TOOLS/DREAMS + skills + permissions + costs
  └── Session — conversation thread: messages.jsonl + meta.json + events.jsonl + summary.md
        └── Turn — 1 round (user msg + assistant + tool cycles + metrics)
```

Rules:
- 1 user, N workspaces, 1 active workspace per REPL/daemon instance
- 1 workspace, N sessions; 1 session active per channel
- 1 session, N turns; append-only

### 2.2 Layering (enforced via eslint-plugin-import)

```
Channels → WorkspaceManager → AgentLoop → CanonicalIR → Provider
                 ↓                ↓             ↓
           SOUL/MEMORY      Permission    Safety/Obs/Cost
                                              ↓
                                          Platform
```

**Layer rules** (MUST):
- `ir/`, `providers/`, `protocol/` — pure TS, NO Bun-specific, NO imports from `core/`/`tools/`/`platform/` (reusable in mobile client).
- `core/` can import `ir/`, `providers/`, `tools/`, `permissions/`, `context/`, `observability/`, `cost/`, `platform/`, `storage/`.
- `tools/` can import `permissions/`, `platform/`, `ir/`; MUST NOT import `core/` or `channels/`.
- `channels/` can import `core/`, `storage/`, `observability/`; MUST NOT import `tools/` directly (only through core loop).
- `platform/` zero dependencies on other nimbus modules (leaf).
- `observability/` + `cost/` + `safety/` are cross-cutting; imported by many but import only from `ir/` + `platform/`.

### 2.3 Data Flow

**User input → response**:
1. Channel adapter receives user message → `SessionEvent{type:'user_msg'}` onto event bus
2. SessionManager routes to active workspace session
3. AgentLoop dispatches via generator pattern: builds prompt (inject SOUL + IDENTITY + MEMORY + env), calls Provider
4. Provider streams CanonicalChunks back
5. If tool_use blocks → Tool executor partitions (read-parallel, write-serial) → runs through Permission gate → executes
6. Tool results appended as CanonicalBlocks → next iteration or final text
7. End-of-turn: TurnMetric emitted, cost recorded, message persisted to JSONL

### 2.4 Storage Root

All persistent data at `~/.nimbus/` (resolved via `platform/paths.ts`).

See META-010 for naming.

## 3. Rationale

- **Layered architecture**: mobile client (v1.0+) can reuse `ir/` + `providers/` + `protocol/` without pulling in `tools/`/`platform/`. Enforces clean boundary now, saves months of refactor.
- **3-tier hierarchy**: matches user mental model (project → conversation → message). Simpler than OpenClaw flat sessions.
- **Generator-based loop**: streams tokens + tool results to channel as they arrive (vs buffering whole turn). Enables cancel at any point.
- **JSONL storage**: append-only = crash-safe + tail-friendly + grep debugging. SQLite deferred unless index needed (v0.5+).

## 4. Consumers

Every spec. Specifically load-bearing for:
- SPEC-101 (workspace), SPEC-102 (session), SPEC-103 (loop)
- SPEC-201 (IR), SPEC-202/203 (providers)
- SPEC-301 (tool executor)
- MOD-10 (core), MOD-15 (platform)

## 5. Evolution Policy

Breaking changes require:
1. RFC spec (`META-XXX-rfc-*.spec.md`) with 7-day review
2. Migration runner (see schema-migration in plan section 14)
3. User announcement in CHANGELOG.md
4. `schemaVersion` bump in all affected persisted files

## 6. Changelog

- 2026-04-15 @hiepht: initial draft + approve (team-lead, foundational)
