---
id: SPEC-901
title: nimbus init wizard + SOUL template generator
status: implemented
version: 0.2.1
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-16
release: v0.1
layer: onboard
depends_on: [SPEC-101, SPEC-501, SPEC-801, META-005]
blocks: []
estimated_loc: 400
files_touched:
  - src/onboard/init.ts
  - src/onboard/questions.ts
  - src/onboard/templates.ts
  - src/onboard/picker.ts
  - src/catalog/picker.ts
  - src/platform/secrets/fileFallback.ts
  - src/observability/errorFormat.ts
  - src/cli.ts
  - src/key/cli.ts
  - tests/onboard/picker.test.ts
  - tests/onboard/templates.test.ts
  - tests/platform/secrets/autoProvision.test.ts
  - tests/observability/errorFormat.test.ts
  - src/onboard/templates/SOUL.template.md
  - src/onboard/templates/IDENTITY.template.md
  - src/onboard/templates/TOOLS.template.md
---

# `nimbus init` Wizard + SOUL Template

## 1. Outcomes

- Running `nimbus init` in any directory creates a complete workspace in <10s with ≤3 prompts (default fast path)
- Default fast path: provider picker (arrow keys), API key (env auto-detect), language picker (skippable)
- `--advanced` flag restores full 7-question wizard for power users
- Vault passphrase auto-provisioned (OS keychain → file fallback) — no `U_MISSING_CONFIG: missing_passphrase` on first run
- Error messages are human-readable 2-line format: summary + action (no raw JSON to stdout)
- Generates valid `SOUL.md` draft from answers — user can refine later, but v0.1 default is useable
- Writes `IDENTITY.md`, `MEMORY.md` (empty sections), `TOOLS.md` (default manifest) + `CLAUDE.md` at repo root
- Idempotent: re-running in existing workspace offers `--force` or aborts with `U_BAD_COMMAND`

## 2. Scope

### 2.1 In-scope
- **Default fast path (v0.2.1)**: 3 prompts — provider picker (↑↓/Enter), API key (env auto-detect), language picker (skippable). All other fields auto-defaulted.
- **`--advanced` flag**: restores full 7-question wizard (workspace name, primary use-case, voice style, language, provider choice, default model class, bash rules preset)
- bash rules preset **conditional: only shown when `primaryUseCase` matches `code`/`dev`/`software`/`programming` case-insensitive; otherwise silently defaults to `balanced`**
- **Auto-provision vault passphrase (v0.2.1)**: called at start of `runInit`, `quickInit`, and `key set` — eliminates `U_MISSING_CONFIG: missing_passphrase` on first run
- **Human-readable errors (v0.2.1)**: `formatError(NimbusError)` returns `{summary, action}` 2-line format; raw JSON to `logger.debug` only
- **Generic TTY picker (`src/onboard/picker.ts`)**: `pickOne<T>()` extracted from catalog picker pattern — re-used by catalog picker
- **Model picker step (SPEC-903)** — runs after key step (SPEC-902): live-fetch `/v1/models` (Anthropic/OpenAI-compat/Ollama) → interactive picker (↑↓/Enter/c/s). On timeout/offline/4xx → `[MODELS] using curated list, may be stale` banner + priceTable fallback; user can always `c` (custom) or `s` (skip = keep default from model-class). Picker output overrides `defaultModel` via `updateWorkspace()`.
- Template renderer (simple `${var}` substitution; no full templating engine)
- Write **6 workspace markdown files** (SOUL, IDENTITY, MEMORY, TOOLS, DREAMS — all always generated; IDENTITY and DREAMS as minimal stubs even though META-005 marks them OPTIONAL) + CLAUDE.md at chosen location
- Create empty directory `<workspaceRoot>/.dreams/` (0700) for future consolidation artifacts (SPEC-112 v0.2 / SPEC-114 v0.3 / Dreaming v0.5)
- Workspace location: default `~/.nimbus/workspaces/{name}`; override `--location <dir>` (absolute OR existing-parent-user-owns; `../etc` rejected)
- Register in `~/.nimbus/workspaces/_index.json` via SPEC-101 `workspaceStore.register()`
- Validate answers inline (workspace name regex `^[a-z][a-z0-9-]{2,31}$`)

### 2.2 Out-of-scope
- Dreams/auto-discovery of existing config → v0.2
- Import from OpenClaw/other agent workspace → v0.3
- GUI wizard → out of roadmap
- Auto-suggest SOUL content via LLM → v0.3

## 3. Constraints

### Technical
- Uses SPEC-801 `confirm()` + readline for questions
- Templates stored as static markdown files in `src/onboard/templates/` (bundled via Bun import)
- Frontmatter fields (`schemaVersion: 1`, `created: YYYY-MM-DD`) required per META-005
- Refuses to overwrite existing files unless `--force`

### UX
- Each question shows default in `[brackets]`, Enter accepts default
- All answers echoed back at end → `Write files? [Y/n]`
- Error on any step aborts cleanly; no partial files left

## 4. Prior Decisions

- **5-8 questions not 20** — too many → abandonment; too few → generic SOUL.md
- **Template subst, not Handlebars/EJS** — trivial substitution enough; avoid dep
- **Workspace at `~/.nimbus/workspaces/{name}` default** — consistent with OpenClaw pattern + single-writer guarantee
- **Generates CLAUDE.md too** — onboards AI collaborator from day 1 per SDD discipline
- **IDENTITY.md always generated** — META-005 marks OPTIONAL but stub prevents "absent vs empty" drift; 3-line placeholder linking to SOUL.md
- **DREAMS.md + .dreams/ scaffolded at init** — reserves slot for SPEC-112/114/v0.5 (OpenClaw alignment)
- **`bashPreset` = strict/balanced/permissive** — full rule lists in `src/onboard/templates/bashRules.{strict,balanced,permissive}.md`, copied into TOOLS.md at init
- **bash preset conditional on use-case** — match `primaryUseCase` against `/\b(code|dev|software|programming)\b/i`; non-dev → silent `balanced` default

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Question set + validators | 7 questions default; regex validates name | 40 | — |
| T2 | Template files (SOUL, IDENTITY, MEMORY, TOOLS, DREAMS, CLAUDE) | Fixtures match META-005 schema; DREAMS.md body = `# Dream consolidations\n\n_(populated by SPEC-112 v0.2 + SPEC-114 v0.3 + Dreaming v0.5)_` | 60 | T1 |
| T3 | `renderTemplate(name, answers)` | Simple `${var}` subst; missing var → `U_MISSING_CONFIG` | 30 | T2 |
| T4 | `nimbus init` command | Prompts → preview → confirm → write all 6 files + `.dreams/` dir (0700) atomically | 60 | T3, SPEC-801 |
| T4b | Invoke SPEC-902 promptApiKey/validateKeyFormat/store | User chats immediately after init | 20 | T4, SPEC-902 |
| T5 | Idempotence + `--force` | Existing workspace → abort or force; tests both paths | 30 | T4 |
| T6 | Custom endpoint/baseUrl prompts | If `provider≠anthropic`, ask endpoint (openai/groq/deepseek/ollama/custom); if `custom`, ask baseUrl (valid http/https URL). Persist to `workspace.json` as `defaultEndpoint`/`defaultBaseUrl`. CLI `--endpoint` / `--base-url` flags bypass prompt. | 25 | T1, T4 |
| T7 | Model picker hook (SPEC-903 T7) | After key step: call `discoverModels()` → `pickModel()`. If user selects/custom → `updateWorkspace(id, {defaultModel})`. Skip keeps the class-based default. `--skip-model-picker` flag + `--no-prompt` bypass. | 15 | T4b, SPEC-903 |

## 6. Verification

### 6.1 Unit Tests
- `questions.test.ts`: name validator rejects `1name`, `UPPER`, `a`; accepts `my-ws`
- `questions.test.ts`: bashPreset prompt SHOWN when `primaryUseCase` contains "code"/"dev"/"software"/"programming" (case-insensitive); SKIPPED for "daily assistant"/"life organizer"/"student"/"writer" → answer defaults silently to `balanced`
- `templates.test.ts`: DREAMS.md renders with frontmatter `schemaVersion: 1` + body heading `# Dream consolidations`; `.dreams/` directory exists with mode 0700 after init
- `templates.test.ts`: rendered SOUL.md parses with gray-matter; frontmatter asserts **exact** `schemaVersion === 1` AND `created === today ISO (YYYY-MM-DD)`; rendered IDENTITY.md non-empty even for minimal preset
- `init.test.ts`: mock answers → generated files match golden fixtures; `--location /absolute/path` accepted; `--location ../etc` rejected with `U_BAD_COMMAND`; verify `workspaceStore.register()` called exactly once after all files written

### 6.2 E2E Tests
- `tests/e2e/init-wizard.test.ts`: spawn `nimbus init`, pipe answers → workspace dir exists with 5 files + CLAUDE.md at cwd
- `tests/e2e/init-idempotent.test.ts`: second run errors; `--force` overwrites

### 6.3 Security Checks
- File mode 0600 on SOUL/IDENTITY/MEMORY (personal content)
- Path for `--location` validated (no traversal)

## 7. Interfaces

```ts
export const InitAnswersSchema = z.object({
  workspaceName: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
  primaryUseCase: z.string().min(3).max(200),
  voice: z.enum(['formal','casual','laconic','verbose']),
  language: z.enum(['en','vi']).default('en'),
  provider: z.enum(['anthropic','openai','groq','deepseek','ollama']),
  modelClass: z.enum(['flagship','workhorse','budget']),
  bashPreset: z.enum(['strict','balanced','permissive']).default('balanced'),
  location: z.string().optional(),
})
export type InitAnswers = z.infer<typeof InitAnswersSchema>

export interface InitWizard {
  ask(): Promise<InitAnswers>            // interactive
  render(answers: InitAnswers): Record<string, string>  // filename → content
  write(answers: InitAnswers, target: string, force: boolean): Promise<void>
  run(opts: { force?: boolean; location?: string }): Promise<void>
}
```

### SOUL template (abbreviated)

```markdown
---
schemaVersion: 1
name: ${workspaceName}
created: ${today}
---

# Identity
I am nimbus, a personal AI agent serving ${workspaceName}.
Primary purpose: ${primaryUseCase}

# Values
- Show preview before destructive or irreversible actions
- State uncertainty explicitly, never fabricate
- Confirm before sending to external services

# Communication Style
- Voice: ${voice}
- Language: ${language}

# Boundaries
- Will NOT auto-delete without explicit confirmation
- Will only modify SOUL.md when user explicitly edits
```

## 8. Files Touched

- `src/onboard/init.ts` (~70 LoC)
- `src/onboard/questions.ts` (~40 LoC)
- `src/onboard/templates.ts` (~40 LoC)
- `src/onboard/templates/*.md` (~5 files, ~200 lines total markdown, not LoC)
- `tests/onboard/` (~150 LoC)

## 9. Open Questions

- [ ] Bundled SOUL examples v0.2: daily assistant, life organizer, student, content creator, writer, researcher, software dev (general-audience, not dev-first)
- [ ] Language detection from system locale — defer v0.2

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — IDENTITY stub; `bashPreset` fixtures; schemaVersion/created asserted; workspaceStore.register; `--location` rules
- 2026-04-15 @hiepht: add DREAMS.md stub + `.dreams/` scaffold (#14, OpenClaw)
- 2026-04-15 @hiepht: vision-audit fixes (#18) — neutralize SOUL Values; bashPreset conditional; bundled examples non-dev
- 2026-04-15 @hiepht: T4b hooks SPEC-902 key prompt/validate/store (#24)
- 2026-04-15 @hiepht: T6 adds endpoint + baseUrl prompts for openai-compat providers (Task #31 — enables vLLM/Ollama/Azure/LiteLLM without manual workspace.json edit)
- 2026-04-15 @hiepht: T7 adds model-picker hook to SPEC-903 (Task #45) — live /v1/models fetch + interactive picker replaces class-based default when user selects; graceful degrade to curated priceTable fallback.
- 2026-04-16 @hiepht: v0.2.1 — reduced default init to 3 picker prompts (provider↑↓, key, language); `--advanced` flag preserves full 7-question wizard; extracted generic `pickOne<T>()` to `src/onboard/picker.ts`; auto-provision vault passphrase (OS keychain → .vault-key file → interactive) called at start of `runInit`/`quickInit`/`key set` — eliminates `U_MISSING_CONFIG: missing_passphrase`; added `src/observability/errorFormat.ts` with human-readable 2-line messages for top-10 error codes; raw JSON demoted to `logger.debug`; `--verbose` flag on CLI surfaces debug detail.
