---
id: META-005
title: SOUL contract — personality files format + injection order
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
layer: meta
depends_on: []
---

# SOUL Contract

## 1. Purpose

Define the format, location, and system-prompt injection order of the 4 personality/memory markdown files per workspace. Establishes the "linh hồn" layer that makes nimbus-os voice consistent cross-session (inspired by [OpenClaw](https://docs.openclaw.ai) + [soul.md](https://github.com/aaronjmars/soul.md)).

## 2. Contract

### 2.1 File set (per workspace)

```
~/.nimbus/workspaces/{wsId}/
├── SOUL.md         — REQUIRED. Identity + values + communication style + boundaries.
├── IDENTITY.md     — OPTIONAL. Role + background (merges into SOUL if absent).
├── MEMORY.md       — REQUIRED. Durable long-term facts (append-only, MemoryTool/Dreaming writes).
├── TOOLS.md        — REQUIRED. Tool availability manifest (declarative, user-editable).
├── DREAMS.md       — OPTIONAL v0.5+. Dream narrative diary.
```

### 2.2 SOUL.md format

```markdown
---
schemaVersion: 1
name: <workspace name>
created: 2026-04-15
---

# Identity
<1-3 paragraphs: who is this agent, for whom, for what purpose>

# Values
- <specific, actionable, testable values — not platitudes>
- e.g. "Show preview/diff before destructive or irreversible actions"
- e.g. "State uncertainty explicitly, never fabricate"
- e.g. "Confirm before sending to external services (email, post, payment)"

# Communication Style
- Voice: <formal/casual/laconic/verbose>
- Language: <primary: en | vi>
- Signatures: <examples of phrasing — lowercase, em-dashes, short sentences, ...>

# Boundaries
- Will NOT: <list specific refusals>
- WILL only if user explicitly requests: <list>
```

**Quality standard** (from [soul.md](https://github.com/aaronjmars/soul.md)):
> "Someone reading your SOUL.md should predict your takes on new topics. If they can't, it's too vague."

### 2.3 MEMORY.md format

```markdown
---
schemaVersion: 1
updated: 2026-04-15
---

# Durable Facts
## <topic>
- <fact with source/timestamp> (2026-04-12)

# Observations (auto-consolidated, v0.4 lite)
## Session summaries
- ...

# Dream consolidations (v0.5+)
## 2026-04-14 Deep Sleep
- ...
```

Write rules:
- MemoryTool: append-only to `# Durable Facts` with file lock (`fcntl`)
- Dreaming (v0.5): writes to `# Dream consolidations` section
- User: can edit anywhere; agent respects user's manual curation
- **Agent NEVER edits SOUL.md or IDENTITY.md** (identity domain — user only)

### 2.4 TOOLS.md format

```markdown
---
schemaVersion: 1
---

# Enabled tools
- Read, Write, Edit, Grep, Glob, Bash — default
- Browser — enable: true (v0.4+)
- AgentTool — enable: true (v0.3+)

# Domain allowlist (Browser, WebFetch)
- github.com/*
- docs.anthropic.com/*

# Bash rules (per-workspace override of user defaults)
- Bash(git:*) — allow
- Bash(rm:*) — ask
- Bash(sudo:*) — deny
```

### 2.5 System prompt injection order (cacheable prefix — STABLE)

```
[SOUL]                  ← cache breakpoint 1 (stable, from SOUL.md)
[IDENTITY]              ← from IDENTITY.md (if present) + static core identity text
[AUTONOMY]              ← static (always same)
[SAFETY]                ← static
[UNTRUSTED_CONTENT]     ← static
[TOOL_USAGE]            ← static + TOOLS.md manifest
[MEMORY]                ← cache breakpoint 2 (from MEMORY.md, rare update)
[TOOLS_AVAILABLE]       ← from TOOLS.md declarative

─── Dynamic below (NOT cached, v0.2+) ───
[MODE]                  ← current permission mode
[GOALS]                 ← active goals (v0.2)
[ENVIRONMENT]           ← git, mailbox, time, failed tools, budget (v0.2)
[SKILLS_AVAILABLE]      ← skill list + whenToUse (v0.2)
```

Cache markers placed at end of `[TOOLS_AVAILABLE]` (breakpoint 2) for Anthropic `cache_control: ephemeral`. Reload SOUL/MEMORY invalidates cache — intentional + documented.

## 3. Rationale

- **Separate files**: user edits SOUL in vim independently from MEMORY; each has distinct lifecycle.
- **Markdown not JSON**: human-friendly, gray-matter frontmatter for machine fields.
- **Read-on-wake**: load each session start (OpenClaw pattern) — live updates applied next session.
- **Cacheable prefix**: ≥90% cache hit from turn 2 on Anthropic (SOUL + IDENTITY + static + TOOLS stable).
- **Agent can't edit SOUL**: prevents feedback loop where agent drifts own personality. User is sole curator.

## 4. Consumers

- SPEC-101 (workspace lifecycle creates files)
- SPEC-104 (workspaceMemory loader)
- SPEC-105 (prompt backbone builder)
- SPEC-304 (MemoryTool)
- SPEC-901 (init wizard generates SOUL template)
- META-005 is the canonical reference

## 5. Evolution Policy

Adding new workspace file (e.g., STYLE.md v0.5):
- Bump schemaVersion in existing files
- Migration runner adds defaults
- Update injection order in SPEC-105

## 6. Changelog

- 2026-04-15 @hiepht: initial + approve
