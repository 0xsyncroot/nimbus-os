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

### Team workflow — proven pattern from v0.1.0-alpha

How work gets done here. Follow this shape when a session starts a new task.

**Roles (model choice matters)**
- **team-lead** = Opus — you (coordination, plan, spec review, final decisions, risk calls)
- **spec-writer-{core,tools,infra}** = Sonnet — parallel spec drafting
- **developer-{core,providers,key,cli-onboard,platform,...}** = Sonnet — parallel implementation
- **reviewer-architect / reviewer-security** = Opus — when specs or code are security/identity-critical
- **qa-engineer** = Sonnet — smoke tests against compiled binary, *not* just `bun test`
- **vision-auditor** = Opus — UX research for feature gaps (e.g., "how do peer tools solve X?")

Use Opus sparingly — only where judgment/synthesis is load-bearing. Default to Sonnet.

**Loop pattern (continuous)**

```
1. Team-lead decomposes user ask into tasks (TaskCreate)
2. Spawn parallel teammates: spec-writers first, then developers, then QA
3. QA runs smoke against compiled binary → finds issue
4. Team-lead assigns fix to `developer-X` (SendMessage + TaskUpdate)
5. Developer ships fix, rebuilds binary
6. QA re-smokes → if green, team-lead commits+tags; if red, go back to 4
7. At milestone (tag ready): commit + tag + push + CD auto-publishes binaries
```

**QA discipline** — test the compiled binary, not just `bun test`. Unit tests catch logic; binary smoke catches config-loading, env-priority, and cross-platform bugs. When a QA step reveals a fix candidate, team-lead should reproduce the QA path locally before assigning — cheaper than a dev round-trip on a misdiagnosed issue.

**Assigning fixes (concrete)** — write the message like you'd hand off to a colleague: ticket ID, reproduction steps verbatim, suspected root cause with file:line, the 2-3 design choices and your chosen option with reasoning, expected LoC delta, test additions required, and "rebuild binary + ping back" as the exit criterion. Don't say "fix the bug" — say "drop the kind-mismatch guard in `alignWorkspaceBaseUrl`, always-align when `--base-url` is explicit, print notice before write, idempotent same-kind+same-url no-op".

**Idle notifications** — when a teammate pings `idle_notification`, either assign next work or send one-line "stand down, next up is X". Don't let them spin.

**Milestone tag workflow**
1. QA green on compiled binary → `git add … && git commit -m '[SPEC-…] …'`
2. `git tag -a vX.Y.Z-tier -m "…" && git push origin main vX.Y.Z-tier`
3. CD (`.github/workflows/release.yml`) auto-builds 5 binaries + SHA256SUMS and attaches to GitHub Release
4. Update `CHANGELOG.md` in the same commit as the tag, not after

**User-facing CLI vs dev scripts — load-bearing distinction**
- `nimbus <verb>` = user product (init, key, daemon, cost)
- `bun run <script>` = dev tool (spec list, typecheck, test, compile:*)
- Never expose SDD tooling as `nimbus spec`. Dev tools live in `scripts/`, not `src/`.

**Cross-platform testing**
- Unix-specific paths (`/etc`, `/tmp`, `/etc/shadow`) must be gated with `process.platform !== 'win32'` (or `=== 'linux'` when even more specific).
- Symlink-based tests need `describe.skipIf(win32)` (Windows requires Developer Mode/admin).
- Use `tmpdir()` + `join()` for ephemeral paths, never string-literal `/tmp/…`.
- CI matrix (Linux+macOS+Windows) enforces this — local `bun test` on Linux is not sufficient evidence.

**Commit & push hygiene**
- Branch `main` is protected: linear history only, 3-OS CI must pass, no force-push, no deletion.
- For v0.1.0-alpha we committed straight to main (single-dev flow). Once the project has external contributors, switch to PR-only flow. The branch protection already blocks force-push, so this is safe.
- Commit message body explains WHY not WHAT. File list is already in the diff.

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

**Shipped**: v0.1.0-alpha (2026-04-15). https://github.com/0xsyncroot/nimbus-os/releases/tag/v0.1.0-alpha
- 42 specs validated (6 META + 36 feature) • 527 unit tests pass on all 3 OS
- CI (Linux/macOS/Windows) + CD (5-target binary release on tag) wired, branch protection enabled
- PolyForm Noncommercial 1.0.0 license

**v0.1.1 polish queue** (order of value):
1. **#37 — SPEC-206 v0.1 subset** (~80 LoC): reasoning-mode resolver + cue detect + `/thinking` slash + capability drop. Spec already approved.
2. **OS keychain passphrase** — replace `NIMBUS_VAULT_PASSPHRASE` env requirement with platform keychain (SPEC-152 already scaffolded).
3. **SPEC-903 v0.1 subset** (~120 LoC): model discovery fetch + cache + wizard picker. Spec approved.
4. **`--no-prompt` flags** — `--provider / --endpoint / --base-url` so init can be scripted fully.

**v0.2 planning (after polish)**: Skills, MCP, compaction, budget enforcement, i18n, migrations. See `/specs/_index.md` for spec statuses.

## 8. Recent Decisions (latest)

Tracked in `/specs/CHANGELOG.md`. Key:

- **2026-04-15** v0.1.0-alpha shipped. License = PolyForm Noncommercial 1.0.0 (personal free, commercial contact author).
- **2026-04-15** `key set --base-url` always aligns workspace (cross-kind switch OK). Reason: explicit `--base-url` is a clear intent signal; silent skip caused QA smoke U_MISSING_CONFIG.
- **2026-04-15** baseUrl priority chain at resolve time: `cliBaseUrl > configBaseUrl > vaultBaseUrl > endpointDefault`. All callers funnel through `resolveProviderKey`.
- **2026-04-15** CI drops `bunfig` coverage threshold — it was failing valid builds.
- **2026-04-15** Release pipeline builds binaries on GitHub runners per-tag, not locally.
- **2026-04-15** Adopted SDD (spec-first + spec-anchored).
- **2026-04-15** `playwright-core` Chromium-only for v0.4 browser.
- **2026-04-15** JSONL not SQLite for sessions.
- **2026-04-15** Platform abstraction from v0.1 (not retrofit).
- **2026-04-15** Cost enforcement deferred to v0.2.
- **2026-04-15** Plugin system v0.5 with signed allowlist.

## 9. Open Questions (need user decision)

- [ ] Workspace rename semantics (v0.2?)
- [ ] Telemetry opt-in (default OFF)
- [ ] Plugin allowlist curator (who signs community plugins?)
- [x] ~~License choice~~ — PolyForm NC 1.0.0 (2026-04-15)

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
