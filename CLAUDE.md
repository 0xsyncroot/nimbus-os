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

### Team workflow — THE construction method (do NOT improvise)

**Principle**: on nimbus-os, any non-trivial task is built by a full expert team, not a single agent. Specs come first, multi-angle review follows, QA smokes the compiled binary, and fixes loop back through developers until green. This was validated across the v0.1.0-alpha sprint (6 HIGH fixes, 527 tests green on 3 OS).

#### Model tiers (cost-aware, don't burn Opus on impl)

| Role | Model | When |
|------|-------|------|
| team-lead | **Opus** | Coordination, spec review, final decisions, risk calls |
| spec-writer-{core,tools,infra} | Sonnet | Parallel spec drafting |
| reviewer-architect | **Opus** | Spec alignment with plan + META contracts |
| reviewer-security | **Opus** | Bash / path / network / secrets / identity code |
| reviewer-performance | **Opus** | Hot paths, streaming, concurrency |
| reviewer-cost | **Opus** | Provider selection, cache, optimizer logic |
| vision-auditor | **Opus** | UX gap research — "how do peer tools solve X?" |
| developer-{core,providers,platform,tools,key,cli-onboard,...} | Sonnet | Parallel implementation |
| qa-engineer | Sonnet | Smoke tests against the **compiled binary** |

Rule: Opus only where judgment/synthesis is load-bearing. Developers default to Sonnet. If a task looks trivial enough to do single-handed, double-check — usually at least a spec + review + test are still needed.

#### The loop (follow in order)

**Phase 1 — Plan (team-lead, Opus)**
1. Decompose the user ask into discrete TaskCreate items.
2. Identify which META/SPEC docs apply and which are missing.
3. Pick models for each role (use the tier table above).

**Phase 2 — Spec (spec-writer, Sonnet, parallel)**
4. Spawn spec-writers in parallel. Each drafts 1-3 specs using `/specs/templates/feature.spec.md`.
5. Specs must include all 6 elements + explicit `files_touched`.
6. Run `bun run spec validate` — must be 0 errors.

**Phase 3 — Multi-angle review (parallel Opus reviewers)**
7. Spawn reviewers in parallel, each reading the same specs through a different lens:
   - architect → consistency with plan + META + existing specs
   - security → threat model, deny-lists, validation gaps
   - performance → hot paths, allocations, streaming correctness
   - cost → provider/model routing, cache strategy, token budget
8. Team-lead reconciles review comments, pushes revisions back to spec-writers if needed.
9. Specs go `draft → approved` only when all reviewers green.

**Phase 4 — Implementation (developer, Sonnet, parallel)**
10. Spawn developers, one per module. Each receives the approved spec(s) + a concrete brief with files, expected LoC, test additions.
11. Developers write impl + tests in the same commit as the spec (SDD: spec+code atomic).
12. Each developer runs `bun test` + `bun run typecheck` + `bun run spec validate` before signaling done.

**Phase 5 — QA (qa-engineer, Sonnet) — 4-smoke protocol (MANDATORY before tag)**

QA must run all 4 smokes on the compiled binary. Unit tests DO NOT substitute for any of the 4 — each caught a real regression that unit tests missed:

1. **PTY REPL smoke** — compile `nimbus-linux-x64`, spawn inside a real PTY (`node-pty` or `script -q`), drive tool-confirm flow with multi-byte Vietnamese input. Catches stdin-byte-bleed between autocomplete → picker (v0.3.10–15 shipped 5 consecutive regressions that unit tests with synthetic streams missed).
2. **Real Telegram smoke** — configure a test bot token + allowlist, send a message that triggers a confirm tool, verify inline_keyboard (Yes/Always/No) renders + callback_query round-trip + `editMessageReplyMarkup` clears buttons. Catches wiring gaps between `core/channelPorts` and `telegram/uiHost`.
3. **Vault upgrade smoke** — existing workspace with `secrets.enc` + a stored API key, binary swap to new version, open new shell WITHOUT `NIMBUS_VAULT_PASSPHRASE`, confirm key is still accessible. Catches any `.vault-key` / passphrase regression (v0.3.6 shipped a silent-clobber that permanently locked users out — HARD RULE §10 encoded after that).
4. **3-OS binary smoke via CD** — tag triggers `.github/workflows/release.yml` which compiles all 5 targets and runs the binary. Catches POSIX-vs-Windows path resolution, encoding, CRLF bugs that Linux-only local tests miss.

If ANY smoke fails → team-lead reproduces locally first (don't round-trip on misdiagnosis) → assigns a **concrete fix** to the responsible developer. Never tag with a known-failing smoke.

**Fix brief template (use verbatim when assigning)**:
- Ticket ID + reproduction steps exactly as QA ran them
- Suspected root cause with `file:line`
- 2-3 design options with the chosen one + why
- Expected LoC delta (should be small; if not, split)
- Test additions required
- Exit criterion: "rebuild binary + ping back"

15. Developer ships fix → QA re-smokes → loop until green.

**Phase 6 — Milestone (team-lead)**
16. When QA green, commit spec+code+tests atomically. Message body explains WHY, not WHAT.
17. Tag: `git tag -a vX.Y.Z-tier -m "…"` and push. CD (`.github/workflows/release.yml`) auto-builds 5 binaries + SHA256SUMS and attaches to the GitHub Release.
18. Update `CHANGELOG.md` in the same commit as the tag, not after.

#### Idle teammates

When a teammate sends `idle_notification`, either (a) assign next work with a concrete brief, or (b) reply one-line "stand down, next up is X". Never leave them spinning.

#### User-facing CLI vs dev scripts — load-bearing distinction

- `nimbus <verb>` = user product (`init`, `key`, `daemon`, `cost`). Lives in `src/cli.ts` and is compiled into the binary.
- `bun run <script>` = dev tool (`spec list`, `typecheck`, `test`, `compile:*`). Lives in `scripts/` and is never shipped to users.
- Never expose SDD tooling as `nimbus spec`. This is a hard rule.

#### Cross-platform testing

- Unix-specific paths (`/etc`, `/etc/shadow`) → gate with `process.platform === 'linux' ? test : test.skip`.
- Symlink-based tests → wrap block in `process.platform === 'win32' ? describe.skip : describe`. Windows requires Developer Mode or admin for `symlinkSync`.
- Ephemeral temp dirs → `join(tmpdir(), 'nimbus-…')`, never literal `/tmp/…`.
- CI matrix (Linux + macOS + Windows) enforces this. Local `bun test` on Linux is not sufficient evidence that CI will be green.

#### Commit & push hygiene

- Branch `main` is protected: linear history only, 3-OS CI must pass, no force-push, no deletion.
- Currently committing straight to main (single-dev flow). When external contributors join, switch to PR-only. Branch protection already blocks force-push, so this is safe to defer.
- Commit message body explains WHY not WHAT — the file list is already in the diff.

#### Publishing to npm — HARD RULE

**NEVER run `npm publish` from local machine. EVER.** User enforced this after
v0.2.3 and v0.2.4 shipped broken (CI failed on macOS + Windows but local-Linux
tests passed, and team-lead bypassed CI by running `npm publish` manually).

Required flow:
1. Verify CI green on `main` at the commit to be tagged:
   `gh run list --limit 1 --json conclusion` → must be `success`.
2. `git tag vX.Y.Z -m "..."` then `git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` npm-publish job re-runs `bun run typecheck` +
   `bun test` as a hard gate, then publishes via `NPM_TOKEN` secret.

If CD is broken, fix CD. Do not fall back to local publish — even if user asks
to "publish fast". This rule is stricter than user's usual speed preference
because bad npm versions can't be unpublished easily (72h window).

#### When NOT to run the full loop

- Trivial one-file edits the user asked for directly (typos, README wording).
- Pure research/read-only questions.
- When the user says "đi thẳng" / "làm nhanh" / "skip spec" — respect the shortcut but note it in CHANGELOG.

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
- **2026-04-16** User data + encryption sanctity HARD RULE added to §10 after v0.3.6 vault-key-overwrite incident. Any code path touching passphrase/vault/credential files requires reviewer-security sign-off + probe-before-write guard + upgrade-into-existing-state regression test. See §10 Forbidden areas subsection for the 7 rules.

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

### HARD RULE — user data + encryption sanctity (enforced since v0.3.6 incident)

**v0.3.6 shipped code that silently overwrote `~/.nimbus/.vault-key` with a
random passphrase when the env var `NIMBUS_VAULT_PASSPHRASE` was absent. Users
who had saved an API key under the original env passphrase were permanently
locked out after upgrading. Root cause: `autoProvisionPassphrase()` (existing
since v0.2.1) had a fallthrough that wrote a fresh random passphrase on any
code path that hit it without a vault envelope probe. v0.3.6 added 7 new call
sites that reached this fallthrough during normal REPL boot in a new shell.**

**Rules to prevent recurrence**:

1. **NEVER touch user secrets/vault/credential files (`.vault-key`, `secrets.enc`, `*.pem`, OS keychain entries) on any code path that can fire without explicit user action.** Reading is OK; writing/deriving/rotating is NOT without a user-initiated command like `nimbus init`, `nimbus key set`, or `nimbus vault reset`.

2. **Before writing any passphrase/key/encrypted file, probe whether an existing artifact would be invalidated.** If a `secrets.enc` exists and the candidate passphrase cannot decrypt it → refuse the write, raise `X_CRED_ACCESS / vault_locked` with a recovery hint. v0.3.7 `canDecryptVault` is the reference pattern — reuse it, do not re-introduce a generate-on-missing fallthrough elsewhere.

3. **Schema changes require migration, not destruction.** If `workspace.json`, `SOUL.md`, `MEMORY.md`, `secrets.enc`, or session JSONL layout changes across a release: write a migration at `src/storage/migrations/` AND backup the old file to `*.migrated-{ts}` before rewriting. If a file cannot be auto-migrated, prompt the user with an explicit recovery flow — NEVER clobber.

4. **Any new `autoProvisionPassphrase()` / `keyring.set()` / `writeFile(vaultKey)` call site is a security-sensitive change.** It requires reviewer-security sign-off + a regression test that simulates the "upgrade into existing-vault, env-unset" scenario.

5. **Sensitive-data plumbing (API keys, bot tokens, OAuth secrets, passphrases) is DESIGN-BEFORE-CODE.** Spawn `reviewer-security` on the design doc first; implement only after approval. Review `SPEC-152` (secrets vault), `META-009` (threat model) for the existing contract.

6. **Never log key/passphrase plaintext.** Pino context, NimbusError context, stdout — all must redact. Mask like `"sk-****abcd"`. Pino must route to `~/.nimbus/logs/nimbus.log` by default (v0.3.8 fix), never stdout where the user sees it.

7. **"Upgrade never destroys user data"** — if a release cannot preserve user state across a binary swap, it is a bug-blocker, not a feature-ship. Gate B QA MUST include "existing-state + binary swap" scenario before tagging (added as regression after v0.3.6).

Violations of these rules are treated as P0 — same priority as active data-loss bugs. When in doubt about a change touching `src/platform/secrets/`, `src/providers/registry.ts`, `src/onboard/`, or any file matching `*key*`, `*vault*`, `*credential*`, `*secret*`: STOP, write a design doc, request reviewer-security, do not code.

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
