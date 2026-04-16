---
id: SPEC-123
title: Action-first agent bias — default SOUL + AUTONOMY rewrite
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: core
depends_on: [META-005, SPEC-105]
blocks: []
estimated_loc: 80
files_touched:
  - src/core/promptSections.ts
  - src/onboard/templates.ts
  - examples/souls/daily-assistant.SOUL.md
  - tests/core/prompts.test.ts
  - tests/onboard/templates.test.ts
---

# Action-first agent bias

## 1. Outcomes

- Model responds to vague asks ("làm hộ việc đang dở") by investigating (Read/Grep/memory) first, not by emitting capability lists + "just say X" templates.
- `AUTONOMY_SECTION` explicitly contains "bias toward action" phrase + one good-shape example + one anti-pattern block.
- `DEFAULT_SOUL_MD` Values are verb-phrased (start, pick, show); no Value bullet begins with "Preview", "Confirm", "Respect" — gates live only in Boundaries.
- Measured: on 10-prompt VN+EN fixture, ≥8/10 canned responses start with a tool_use block, not a disclaimer paragraph.

## 2. Scope

### 2.1 In-scope
- Rewrite `AUTONOMY_SECTION` in `src/core/promptSections.ts` (~25→~45 LoC) with anti-pattern block.
- Rewrite `DEFAULT_SOUL_MD` in `src/onboard/templates.ts:158-180` with Values = verbs, Boundaries isolated.
- Rewrite wizard `SOUL_TEMPLATE` values block (`src/onboard/templates.ts:17-22`) same pattern.
- Align `examples/souls/daily-assistant.SOUL.md:11-18` Values with new schema.
- Fixture test: 10-prompt VN+EN set; assert system prompt contains "bias toward action" + anti-pattern + injection order unchanged.

### 2.2 Out-of-scope (v0.4+)
- Runtime LLM-judge behavioral evaluation (v0.4).
- Changes to SAFETY/UNTRUSTED/TOOL_USAGE sections.
- Per-channel tone overrides.

## 3. Constraints

### Technical
- Prompt size stays under `PROMPT_SIZE_WARN_BYTES` (32KB).
- Injection order unchanged — only section *contents* mutate.
- Boundaries section remains sole home for "Will NOT" bullets.
- No new deps.

### Security
- Anti-pattern example is quoted (triple-backtick fenced), cannot be escaped into model instruction.

## 4. Prior Decisions

- **Rewrite Values, not append new section** — bolting "bias" on top of defensive SOUL creates contradictory signals; users perceive whole tone, not missing clause.
- **Keep Boundaries intact** — destructive-action confirmation still load-bearing; we move gates (Values → Boundaries), not remove.
- **Include anti-pattern example inline** — Claude Code achieves action-bias without examples, but Sonnet in VN context has stronger politeness prior; negative examples counter it faster than positive-only instructions. Reference: `/root/develop/nimbus-cli/src/constants/prompts.ts:882-898` (Claude Code canonical bias section).
- **OpenClaw contrast**: `/root/develop/zeroclaw/src/agent/prompt.rs:33-46` — Skills-first contract makes "what can I do" implicit; nimbus lacks equivalent until SPEC-310 lands, so AUTONOMY must carry the weight.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | Rewrite AUTONOMY_SECTION with "bias toward action" phrase + anti-pattern block | prompt contains "bias toward action" + anti-pattern literal | 25 | — |
| T2 | Rewrite DEFAULT_SOUL_MD + SOUL_TEMPLATE values block (verbs only) | no Value bullet starts with Preview/Confirm/Respect | 20 | — |
| T3 | Align `examples/souls/daily-assistant.SOUL.md` Values | same verb-first pattern | 15 | T2 |
| T4 | Fixture test (10 prompts VN+EN, snapshot + shape heuristics) | all pass, bias text present in built prompt | 20 | T1,T2 |

## 6. Verification

### 6.1 Unit Tests
- `templates.test.ts`: snapshot DEFAULT_SOUL_MD + SOUL_TEMPLATE; assert Values bullets all begin with verbs from allowlist (`[Start,Pick,Show,State,Investigate,Act]`).
- `prompts.test.ts`: buildSystemPrompt contains `"bias toward action"` + anti-pattern fence. Injection order unchanged (SOUL → IDENTITY → SESSION_PREFS → AUTONOMY → SAFETY → UNTRUSTED → TOOL_USAGE → MEMORY → TOOLS_AVAILABLE).

### 6.2 Regression
- Existing snapshot tests for DEFAULT_SOUL_MD / AUTONOMY_SECTION updated in same commit.
- `bun run spec validate` 0 errors.

### 6.3 Smoke
- Manual check on compiled binary with the exact v0.3 regression prompt: "là e làm hộ mấy công việc đang dở của a". Expected: ≤1-line reply then a Read/Grep tool call — not a capability list.

## 7. Interfaces

No new types. Edits to:
- `export const AUTONOMY_SECTION: string` — body rewritten.
- `export const DEFAULT_SOUL_MD = (now: string) => string` — body rewritten.
- `export const SOUL_TEMPLATE` — Values block rewritten.

## 8. Files Touched

- `src/core/promptSections.ts` (~25 LoC delta)
- `src/onboard/templates.ts` (~30 LoC delta)
- `examples/souls/daily-assistant.SOUL.md` (~15 LoC delta)
- `tests/core/prompts.test.ts` (new assertions, ~15 LoC)
- `tests/onboard/templates.test.ts` (new assertions, ~15 LoC)

## 9. Open Questions

- [ ] Should the anti-pattern block be VN or EN? Decision: EN (prompt is EN; model generalizes across target languages).

## 10. Changelog

- 2026-04-16 @hiepht: renumbered SPEC-119→SPEC-123 (collision with v0.1 audit-log-append-minimal)
- 2026-04-16 @hiepht: draft — v0.3 analyst report (bias fix). Root cause: defensive SOUL Values + weak AUTONOMY_SECTION drowned by 3 following caution blocks + no anti-pattern examples. Claude Code's `src/constants/prompts.ts:892-898` is the authoritative reference.
