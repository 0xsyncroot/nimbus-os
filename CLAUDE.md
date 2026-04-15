# nimbus-os — AI Agent Memory

> Read this file fully at session start. Keep <400 lines.
> Last updated: 2026-04-15 | Current release target: **v0.1 MVP**

---

## 1. What This Project Is

**nimbus-os** = personal AI OS running local 24/7. **For all users** (not just devs). Defining traits (vision):

- **Shaped like OpenClaw** (SOUL/IDENTITY/MEMORY/DREAMS files, multi-channel, local-first, daemon)
- **More autonomous** — agent decides + acts with smart guard-rails (not just react to prompts)
- **Smarter control** — observability + cost + permission gates that catch problems before they cost the user
- **Self-improving** — Dreaming + memory consolidation + rule-based optimizer give it evolution over time
- **Own reasoning style** — agent develops a consistent "linh hồn" via SOUL.md + persistent MEMORY across sessions
- **🌟 Runtime SDD (the differentiator)** — agent applies SDD pattern internally to its OWN task planning: generates a mini-spec from user intent (5 sections), uses it as structured thinking, shows inline FYI, then executes immediately. Spec is **internal planning aid**, NOT a per-turn user gate. Permission gate (SPEC-401) handles destructive ops orthogonally. High-risk actions flagged in spec.risks trigger single confirm. User opt-in `/spec-confirm always` for power users (default OFF). Vision = "agent tự chủ thật sự" — minimize friction, maximize plan quality (see SPEC-110)

Bun+TypeScript, 5 releases v0.1→v0.5, ~17,930 LoC total.

**Is a**: 1-user OS with shell/filesystem/network/browser access + cross-session memory + linh hồn nhất quán.
**Not a**: chatbot wrapper, cloud SaaS, multi-tenant service.

**Inspirations**: [OpenClaw](https://github.com/openclaw/openclaw) (architecture), [soul.md](https://github.com/aaronjmars/soul.md) (personality), [Claude Code](https://claude.com/claude-code) (agentic loop).

## 2. Current Phase

- **Active release**: v0.1 MVP (~4200 LoC target, 5-6 weeks part-time)
- **Progress**: See `/specs/_index.md` for spec statuses
- **Started**: 2026-04-15
- **Full plan**: `/root/.claude/plans/stateful-stargazing-ullman.md`

## 3. Architecture (1-min read)

```
Channels → WorkspaceManager → AgentLoop → CanonicalIR → Provider
                ↓                  ↓             ↓
          SOUL/MEMORY         Permission    Safety/Obs/Cost
                                              ↓
                                         Platform (Win/Linux/macOS)
```

- Full architecture: `/specs/00-meta/META-001-architecture.spec.md`
- Error taxonomy: `/specs/00-meta/META-003-error-taxonomy.spec.md`
- Canonical IR: `/specs/00-meta/META-004-canonical-ir.spec.md`
- SOUL contract: `/specs/00-meta/META-005-soul-contract.spec.md`
- Threat model: `/specs/00-meta/META-009-threat-model.spec.md`
- Naming: `/specs/00-meta/META-010-naming.spec.md`

## 4. Working Style (MANDATORY for AI agents)

### Spec-Driven Development (SDD) — DEV WORKFLOW (NOT a nimbus feature)

SDD is the **internal methodology** for building nimbus-os. The `bun run spec` script is for developers to manage specs. It is NOT exposed via the user-facing `nimbus` CLI. Don't add `nimbus spec` subcommand to user CLI.

1. **NEVER write code without an approved spec** in `/specs/`
2. **NEVER modify code without updating its spec** in the same commit
3. **Spec template**: `/specs/templates/feature.spec.md`
4. **Validator**: run `bun run spec validate` before commit
5. **Drift**: `bun run spec check-drift` before commit (v0.2+)

### Workflow (5 steps)
```
1. User describes task
2. You write/update spec at /specs/{module}/SPEC-XXX-name.spec.md
3. User reviews spec (≤5 min) → approves
4. You implement per spec (tasks → tests → verify)
5. Run `bun run spec validate` → commit spec+code atomically
```

### Code Rules
- **Bun-native**: use `bun:sqlite`, `Bun.serve`, `Bun.file`, `Bun.spawn`. `node:*` imports (e.g., `node:readline`, `node:path`, `node:fs`) ARE allowed — Bun re-exports them natively. AVOID Node-only npm packages (`commander`, `chalk` cross-platform quirks) when Bun has native equivalents.
- **TypeScript strict**: no `any`, `strictNullChecks`, `noUncheckedIndexedAccess`
- **Max 400 LoC per file**. Exceed → split.
- **Functional + closures**. No class-based inheritance.
- **Zod** for tool inputs + all untrusted boundaries.
- **Errors**: `throw new NimbusError(ErrorCode.X_YYY, ctx)`. Never string throw. No `new Error('...')`.
- **No `console.log`**. Use `logger.info|warn|error` (pino).
- **Naming**: see `/specs/00-meta/META-010-naming.spec.md`.

### Commit Format
`[SPEC-XXX] imperative subject` (e.g., `[SPEC-101] implement workspace lifecycle`)

## 5. Where to Find Things

| Thing | Location |
|-------|----------|
| Specs | `/specs/{00-meta,10-core,15-platform,...}` |
| Source code | `/src/{core,ir,providers,platform,tools,...}` |
| Tests | `/tests/` (mirror src/ layout) |
| Spec templates | `/specs/templates/` |
| Spec index (auto-gen) | `/specs/_index.md` |
| Spec history | `/specs/CHANGELOG.md` |
| This memory | `/CLAUDE.md` |
| Release roadmap | `/specs/00-meta/META-006-release-roadmap.spec.md` |
| Full plan | `/root/.claude/plans/stateful-stargazing-ullman.md` |
| Docs | `/docs/` |

## 6. Conventions (Summary)

- **File names**: `camelCase.ts` (e.g., `workspaceStore.ts`, NOT `workspace-store.ts`)
- **Workspace files**: UPPERCASE `.md` (SOUL.md, IDENTITY.md, MEMORY.md, TOOLS.md)
- **Types/classes**: `PascalCase` (`Workspace`, `CanonicalBlock`)
- **Functions/vars**: `camelCase` (`loadWorkspace()`, `sessionId`)
- **Constants**: `SCREAMING_SNAKE_CASE` (`DEFAULT_MODEL`, `MAX_TOKENS`)
- **Enum values**: `SCREAMING_SNAKE_CASE` (`ErrorCode.P_NETWORK`)
- **Spec IDs**: `SPEC-XXX-kebab-name` (XXX = 3-digit, module-aligned)
- **Versions**: `v0.1`→`v0.5` (NOT "Phase 1-5")
- **Test format**: `describe('SPEC-XXX: feature name', ...)` for traceability
- **Commits**: `[SPEC-XXX] imperative subject`
- **toolUseId** (camelCase, internal) ↔ Anthropic `tool_use_id` / OpenAI `tool_call_id`

## 7. Active Work

Check `/specs/_index.md` for in-progress specs.

**Current focus**: v0.1 MVP scaffolding. Next up (in order):
1. Meta specs (META-001 → META-010) — in progress
2. Feature specs (SPEC-101 → SPEC-911) — pending
3. SPEC-911 SDD spec dev tooling (`bun run spec ...`, internal — used to validate specs)
4. SPEC-151+152 `platform/` module (paths, shell, secrets — foundation)
5. SPEC-201+202+203 IR + providers
6. SPEC-101+102+103 core (workspace, session, loop)
7. ... tiếp tục theo deps DAG

## 8. Recent Decisions (latest 5)

Tracked in `/specs/CHANGELOG.md`. Key:

- **2026-04-15** Adopted SDD (spec-first + spec-anchored). Reason: 1-dev + AI-assisted requires durable truth.
- **2026-04-15** Chose `playwright-core` Chromium-only for v0.4 browser. Reason: -1GB vs full Playwright.
- **2026-04-15** JSONL not SQLite for sessions. Reason: append-only crash-safe + grep debug.
- **2026-04-15** Platform abstraction from v0.1 (not retrofit). Reason: 3× effort later.
- **2026-04-15** Cost enforcement deferred to v0.2. Reason: v0.1 scope realistic 4200 LoC.
- **2026-04-15** Plugin system v0.5 (not v0.4). Reason: Security — signed allowlist only.
- **2026-04-15** CI matrix Win/macOS/Linux from v0.1. Reason: catch platform bugs early.

## 9. Open Questions (need user decision)

- [ ] License choice (MIT / Apache 2 / AGPL?)
- [ ] Workspace rename semantics (v0.2?)
- [ ] Telemetry opt-in (default OFF)
- [ ] Plugin allowlist curator (who signs community plugins?)

## 10. Memory for Next Session

### When resuming work
1. **Read this file (CLAUDE.md) fully**
2. Read `/specs/_index.md` to see spec statuses
3. Find spec with `status: in-progress` → continue there
4. If none: read `/specs/00-meta/META-006-release-roadmap.spec.md` → pick next spec with deps satisfied
5. If unclear: ask user, never guess

### Don't
- Modify user workspace `SOUL.md`/`MEMORY.md` (that's runtime data, not code)
- Commit without `bun run spec validate` passing
- Create specs >500 words — split instead
- Skip tests even if spec says "simple"
- Use `any` type
- Log raw secrets or prompt content in audit
- Hotfix code without updating spec (AI next session will revert via spec)

### Do
- Ask before making architectural decisions
- Add to `/specs/CHANGELOG.md` when making non-trivial decisions
- Run `bun test` + `bun run typecheck` before commit
- Update `files_touched` in spec after edits
- Verify `depends_on` in spec frontmatter matches actual imports
- When blocked → check plan `/root/.claude/plans/stateful-stargazing-ullman.md`

### Forbidden areas (require security review)
- `src/permissions/bashSecurity.ts` — tier-1 security logic
- `src/permissions/pathValidator.ts` — sensitive paths
- `src/safety/` — trust boundary + audit
- `src/platform/secrets/` — credential storage
- Default templates for SOUL.md/IDENTITY.md (shape agent identity)

## 11. Tech Stack Quick Reference

- **Runtime**: Bun ≥1.2 (native TS, HTTP+WS, bun:sqlite)
- **Language**: TypeScript strict
- **LLM**: `@anthropic-ai/sdk` + `openai` (OpenAI-compat endpoint)
- **Schema**: Zod
- **Markdown**: gray-matter (frontmatter)
- **Shell**: shell-quote (POSIX) + custom pwsh quoter
- **Crypto**: Bun native AES-GCM
- **Logger**: pino
- **Browser** (v0.4+): playwright-core + @mozilla/readability + turndown
- **Test**: `bun test`

**Full stack**: see plan section 5 "Tech Stack".

## 12. Getting Help

- Plan questions → read `/root/.claude/plans/stateful-stargazing-ullman.md`
- Architecture questions → read `/specs/00-meta/META-001-architecture.spec.md`
- "Why this decision?" → read relevant spec's **Section 4 Prior Decisions**
- "What's the current state?" → run `bun run spec list --status=in-progress`
- Stuck debugging → read `/docs/security.md` for security gotchas, `/docs/providers.md` for provider quirks
