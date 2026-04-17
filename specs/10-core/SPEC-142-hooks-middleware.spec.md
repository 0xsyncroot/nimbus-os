---
id: SPEC-142
title: Hooks middleware — pre/postToolUse + userPromptSubmit
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P4, P5, P6]
depends_on: [SPEC-118, SPEC-301, SPEC-103, SPEC-401]
blocks: [SPEC-143, SPEC-144]
estimated_loc: 300
files_touched:
  - src/core/hooks/registry.ts
  - src/core/hooks/runner.ts
  - src/core/hooks/types.ts
  - src/tools/executor.ts
  - src/core/loop.ts
  - tests/core/hooks/runner.test.ts
---

# Hooks Middleware — Pre/PostToolUse + UserPromptSubmit

## 1. Outcomes

- Synchronous middleware layer ABOVE the tool executor: a registered `preToolUse` hook can inspect, mutate, or VETO a tool call before it runs; `postToolUse` observes result + can append to audit; `userPromptSubmit` can rewrite or gate the user input.
- Distinct from SPEC-118 event bus (which is broadcast-only, no veto). Hooks compose: bus logs what happened, hooks shape what happens.
- Enables: security re-check before tool-register (SPEC-136), plan-diff confirm (SPEC-144), LSP post-edit feedback (SPEC-143), and external `.nimbus/hooks.json` user customization (deferred to v0.5).
- Ported minimal subset from Claude Code `src/utils/hooks/*`; skip `SessionEnd` / `Notification` variants.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Hook types + veto contract | `PreToolUseHook` returns `{action:'allow'|'deny'|'mutate', …}`; typed | 60 | SPEC-301 |
| T2 | Registry (add/remove/list, per-hook priority) | Idempotent by `id`; ordered run by priority | 70 | T1 |
| T3 | Runner: executor calls runner before dispatch, after result | Deny short-circuits with structured error; mutate replaces args | 90 | T1, T2, SPEC-301 |
| T4 | `userPromptSubmit` hook point in loop.ts | User prompt passes through hooks before prompt-backbone build | 40 | T1, SPEC-103 |
| T5 | Bridge: bus events emitted for each hook invocation (non-vetoing) | Observability keeps parity | 40 | SPEC-118 |
