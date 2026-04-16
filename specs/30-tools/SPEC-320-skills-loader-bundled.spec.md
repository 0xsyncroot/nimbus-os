---
id: SPEC-320
title: Skills loader + 7 bundled skills
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.2
layer: tools
depends_on: [SPEC-301, SPEC-103]
blocks: [SPEC-310]
estimated_loc: 300
files_touched:
  - src/skills/types.ts
  - src/skills/frontmatter.ts
  - src/skills/loader.ts
  - src/skills/activation.ts
  - src/skills/bundled/index.ts
  - src/skills/bundled/plan.ts
  - src/skills/bundled/summarize.ts
  - src/skills/bundled/organize.ts
  - src/skills/bundled/commit.ts
  - src/skills/bundled/research.ts
  - src/skills/bundled/codeReview.ts
  - src/skills/bundled/debug.ts
  - tests/skills/loader.test.ts
  - tests/skills/activation.test.ts
---

# Skills loader + 7 bundled skills

## 1. Outcomes

- Agent has 7 useful built-in skills accessible via `/plan`, `/summarize`, `/commit`, etc.
- Users can create custom workspace skills by dropping a `SKILL.md` file in `skills/` directory
- LLM can auto-activate skills via SkillTool when user intent matches `whenToUse` patterns
- Workspace skills override bundled skills by name — full customizability

## 2. Scope

### 2.1 In-scope

- **Skill format**: `SKILL.md` with YAML frontmatter (name, description, whenToUse, allowedTools, permissions.sideEffects, context: inline|fork) + markdown body (prompt template)
- **Loader**: `loadBundledSkills()` from `src/skills/bundled/*.ts` + `loadWorkspaceSkills(dir)` scanning `~/.nimbus/workspaces/{ws}/skills/*/SKILL.md`. Merge: workspace overrides bundled by name.
- **Activation**: (1) Slash command `/skill-name [args]` — direct lookup. (2) SkillTool in agent tool belt — LLM decides based on skill listing in system prompt (name + description + whenToUse, capped to 1% of context window).
- **Inline context** (default): skill markdown body injected as user message into agent loop with allowedTools + model overrides applied.
- **Fork context** (optional): skill runs in sub-agent via agent spawn. Result returned as tool result.
- **Permission check**: skill's `sideEffects` field routes through SPEC-401 gate. Bundled skills are trusted (auto-allow). Workspace skills prompt user on first use if sideEffects is `write` or `exec`.
- **7 bundled skills**: plan, summarize, organize, commit, research, codeReview, debug

### 2.2 Out-of-scope

- Community skills registry (SPEC-310, v0.3)
- Skill dependencies (v0.3)
- Skill versioning (v0.3)
- Skill arguments with typed schema (v0.3 — v0.2 uses raw string `$ARGUMENTS`)

## 3. Constraints

### Technical
- Bun-native, TypeScript strict, no `any`, max 400 LoC per file
- SKILL.md frontmatter parsed via `gray-matter` (already a dependency)
- Bundled skills: markdown-first (prompt is the skill, not code)
- No class inheritance — functional `registerBundledSkill()` pattern

### Performance
- Skill loader: <50ms for 20 skills (file scan + parse)
- Skill listing in system prompt: <1% of context window budget

## 4. Prior Decisions

- **SKILL.md format** — adopted from Claude Code (src/skills/ pattern). YAML frontmatter + markdown body. Users create skills without writing TypeScript. Proven at scale (162+ community skills in OpenClaw ClawHub).
- **Inline by default, fork optional** — most skills inject prompt inline (cheap, simple). Fork for expensive skills like `research` that benefit from a sub-agent.
- **Workspace overrides bundled** — user can replace `commit` skill with their own by placing `skills/commit/SKILL.md` in workspace. Full customizability without modifying nimbus source.
- **sideEffects from SPEC-103 taxonomy** — reuses `'pure'|'read'|'write'|'exec'` instead of inventing new permission model.
- **No typed arguments v0.2** — `$ARGUMENTS` string substitution is sufficient. Typed schemas (Zod) deferred to v0.3 with SPEC-310 manifest.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | SkillDefinition type + Zod schema | type covers all frontmatter fields, validated | 30 | — |
| T2 | parseFrontmatter for SKILL.md | parse YAML + body, reject malformed | 40 | T1 |
| T3 | loadWorkspaceSkills — scan dir, parse, validate | loads skills from workspace skills/ | 50 | T2 |
| T4 | loadBundledSkills — register 7 built-in | bundled skills available in registry | 20 | T1 |
| T5 | Skill registry — Map + merge logic | workspace overrides bundled by name | 30 | T3,T4 |
| T6 | activateSkill — resolve, permission, inject/fork | slash command + SkillTool activation works | 60 | T5 |
| T7 | 7 bundled skill prompts | each skill has tested markdown body | 50 | — |
| T8 | Tests | loader, activation, frontmatter, override | 120 | all |

## 6. Verification

### 6.1 Unit Tests
- Frontmatter: valid SKILL.md parsed, malformed rejected, missing required fields → error
- Loader: workspace scan finds skills, bundled registration works, merge override by name
- Activation: slash `/commit` resolves + injects, SkillTool call works, fork context spawns sub-agent
- Permission: `exec` side-effect prompts user, `pure` auto-allowed

### 6.2 E2E Tests
- `/plan "build a REST API"` → agent receives plan skill prompt + allowed tools
- Custom workspace skill overrides bundled → custom prompt used

### 6.3 Security Checks
- Workspace skill with `exec` sideEffects → permission gate fires
- Skill listing capped to 1% context budget (no context overflow)

## 7. Interfaces

```ts
interface SkillDefinition {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools?: string[];
  permissions: { sideEffects: 'pure' | 'read' | 'write' | 'exec' };
  context: 'inline' | 'fork';
  body: string;                    // markdown prompt template
  source: 'bundled' | 'workspace';
}

function loadSkills(workspaceDir: string): Promise<Map<string, SkillDefinition>>;
function activateSkill(name: string, args: string, loop: AgentLoop): Promise<SkillResult>;
function registerBundledSkill(def: Omit<SkillDefinition, 'source'>): void;
```

### 7 Bundled Skills

| Name | whenToUse | allowedTools | sideEffects |
|------|-----------|-------------|-------------|
| plan | "make a plan", "break this down" | Read, Write | write |
| summarize | "summarize", "tldr", "what does this do" | Read, Grep | pure |
| organize | "organize", "restructure", "clean up" | Bash, Read, Write | exec |
| commit | "commit", "save changes" | Bash, Read | write |
| research | "research", "investigate", "trace the flow" | Read, Grep, Glob | pure |
| codeReview | "review this", "code review" | Read, Grep | pure |
| debug | "debug", "why is this failing" | Bash, Read, Grep | exec |

## 8. Files Touched

- `src/skills/types.ts` (new, ~30 LoC)
- `src/skills/frontmatter.ts` (new, ~40 LoC)
- `src/skills/loader.ts` (new, ~80 LoC)
- `src/skills/activation.ts` (new, ~60 LoC)
- `src/skills/bundled/index.ts` (new, ~20 LoC)
- `src/skills/bundled/{plan,summarize,organize,commit,research,codeReview,debug}.ts` (new, ~50 LoC total)
- `tests/skills/loader.test.ts` (new, ~80 LoC)
- `tests/skills/activation.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Should `whenToUse` support regex in addition to keyword matching? (defer v0.3)
- [ ] Path-activated skills (Claude Code pattern: skill activates when touching specific files)? (defer v0.3)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on Claude Code skills reverse-engineering (src/skills/ + loadSkillsDir)
