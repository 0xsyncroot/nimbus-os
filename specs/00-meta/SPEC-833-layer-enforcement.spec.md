---
id: SPEC-833
title: Layer enforcement — eslint no-restricted-paths + fix V1 violations
status: approved
version: 0.2.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3
layer: meta
pillars: [P1]
depends_on: [META-001]
blocks: []
estimated_loc: 220
files_touched:
  - scripts/lint/layerRules.ts
  - src/core/channelPorts.ts
  - src/channels/runtime.ts
  - src/channels/cli/repl.ts
  - src/tools/builtin/Telegram.ts
  - src/tools/todoWriteTool.ts
  - tests/lint/layerRules.test.ts
  - tests/tools/telegram.test.ts
---

# Layer enforcement — eslint no-restricted-paths + fix V1 violations

## 1. Outcomes

- CI fails when `src/tools/` imports `src/channels/` (V1 violation, Expert 1) — previously silent.
- CI fails when `src/channels/` imports `src/tools/` directly (must go through core) — matches META-001 layer DAG.
- CI fails when `src/core/` / `src/ir/` / `src/providers/` import Bun or `node:*` APIs that break pure-TS reuse.
- Existing two V1 violations fixed in the same commit: `src/tools/builtin/Telegram.ts` and `src/tools/todoWriteTool.ts`.
- Future refactors caught at pre-commit, not during a 7-regression debugging session.

## 2. Scope

### 2.1 In-scope
- Add `eslint-plugin-boundaries` (or native `no-restricted-imports` rule) config in `scripts/lint/layerRules.ts` driving `.eslintrc`
- Layer DAG enforced (from META-001):
  - `core`, `ir`, `providers`, `protocol` — cannot import `channels`, `tools`, `platform`
  - `channels` — cannot import `tools` (must emit `UIIntent` via core/ui, per SPEC-830)
  - `tools` — cannot import `channels` (fixes Expert 1 V1)
  - `platform` — leaf (no internal deps)
- Fix `src/tools/builtin/Telegram.ts`: remove direct `channels/telegram/` import; emit `UIIntent.status` + delegate adapter call through `ChannelRuntime` handle injected at construct time
- Fix `src/tools/todoWriteTool.ts`: stop importing ANSI renderer from `channels/cli/`; emit structured `Canonical` output, let channel render
- Add unit test that feeds fixture code to the eslint runner and asserts rule fires
- Wire into `bun run lint` so CI runs it

### 2.2 Out-of-scope (defer to other specs)
- Full dependency-cruiser / madge graph visualization → v0.4
- Forbidding specific third-party deps (e.g., `chalk`) → follow-up spec
- Moving rules into `bun run spec validate` → v0.2+ alignment
- Runtime verification (import-hook) → over-engineering, lint suffices

## 3. Constraints

### Technical
- Stick with existing eslint pipeline (already in `package.json`); avoid new dep if a built-in rule suffices
- Max 400 LoC per file
- Rules must run under 3 s on the full tree (CI budget)

### Security
- N/A directly, but layer enforcement indirectly protects trust boundary (tools must not reach into channels' auth state)

### Performance
- `bun run lint` overall budget stays <15 s (SPEC-828 baseline); rule-eval cost <2 s incremental

## 4. Prior Decisions

- **eslint rule over custom script** — already runs in CI, zero new infra; a custom AST walker duplicates work.
- **Ship fixes in same commit as rule** — otherwise CI stays red and the rule gets disabled. Expert 1 flags exactly two violations; both are small (~100 LoC each to fix).
- **Emit `UIIntent.status` from `Telegram.ts` tool, not channel call** — aligns with SPEC-830 + SPEC-831; tool becomes pure, channel picks presentation.
- **todoWriteTool fix: structured output, not ANSI** — matches META-004 Canonical IR; CLI render layer already has `markdownRender.ts`.
- **No class inheritance for rule config** — config is a plain object passed to eslint; matches CLAUDE.md §4.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | Define layer DAG in `scripts/lint/layerRules.ts` | eslint config loads, rules enumerated | 80 | — |
| T2 | Fix `tools/builtin/Telegram.ts` V1 | No `channels/` import; tool emits intent | 60 | T1 + SPEC-830 stub |
| T3 | Fix `tools/todoWriteTool.ts` V1 | No ANSI renderer import; structured output | 40 | T1 |
| T4 | Wire `bun run lint` in CI | CI matrix (3 OS) runs layer rules | 10 | T1 |
| T5 | Fixture tests: rule fires on synthetic violation | `bun test tests/lint/` green | 30 | T1 |

## 6. Verification

### 6.1 Gate A — Reviewer
- reviewer-architect: layer DAG matches META-001 exactly; no false-positive exemptions
- reviewer-security: Telegram tool fix does not bypass `allowedUserIds` gate (call still goes through runtime-registered adapter)

### 6.2 Gate B — PTY smoke
- Not applicable (lint-only; Gate B waived for this spec)

### 6.3 Gate C — CI
- `bun run lint` green on Linux + macOS + Windows after fixes
- Synthetic violation (added via test fixture) → `bun run lint` exits non-zero
- `bun test tests/lint/` green
- `bun run spec validate` green

## 7. Interfaces

```ts
// scripts/lint/layerRules.ts
export interface LayerRule {
  from: string;          // glob: "src/tools/**"
  forbid: string[];      // globs: ["src/channels/**"]
  reason: string;        // shown in eslint error
}

export const LAYER_RULES: LayerRule[];

// exported for eslint config:
export function toEslintNoRestrictedPaths(rules: LayerRule[]): unknown;
```

## 8. Files Touched

- `scripts/lint/layerRules.ts` (new, ~80 LoC)
- `src/tools/builtin/Telegram.ts` (modify, remove `channels/` import, emit intent, ~60 LoC delta)
- `src/tools/todoWriteTool.ts` (modify, remove ANSI import, structured output, ~40 LoC delta)
- `src/core/ui/intent.ts` (depends — already created by SPEC-830)
- `tests/lint/layerRules.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Do we whitelist `src/channels/ChannelAdapter.ts` being imported by `core/` for type-only imports? (yes, add `type-only` exemption)
- [ ] Extend rules to forbid `any` type via eslint? (follow-up, not this spec)

## 10. Changelog

- 2026-04-17 @hiepht: draft initial; Expert 1 identified V1 violations, ships in parallel to SPEC-830/831/832
