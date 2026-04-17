---
id: SPEC-143
title: LSP-lite post-edit feedback — tsc/pyright errors next turn
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: core
pillars: [P5, P9]
depends_on: [SPEC-302, SPEC-303, SPEC-142]
blocks: []
estimated_loc: 200
files_touched:
  - src/core/lspLite/runner.ts
  - src/core/lspLite/diagnostics.ts
  - src/core/hooks/registry.ts
  - tests/core/lspLite/runner.test.ts
---

# LSP-lite Post-edit Feedback — tsc/pyright Errors Next Turn

## 1. Outcomes

- After a `Write` or `Edit` tool touches a `.ts` / `.tsx` / `.py` file, a `postToolUse` hook (via SPEC-142) runs the project's type checker in a scoped mode (`tsc --noEmit --incremental` or `pyright --outputjson <path>`) with a 10s timeout and feeds structured diagnostics back into the next turn as a system message.
- Agent catches type errors it just created without the user having to prompt "run tsc and fix errors" — closes the loop on P5 "tự viết code" by validating what was written.
- Adapted from Claude Code `src/services/lsp/passiveFeedback.ts`; skips full LSP server (overkill) — shell-out to CLI compilers is enough at ~200 LoC.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Checker detection + per-language runner | Finds `tsc` / `pyright` in project; no-op when absent | 70 | SPEC-303 |
| T2 | Diagnostics parser (compact N≤20) | Converts compiler output to `{file, line, code, message}[]` | 50 | — |
| T3 | postToolUse hook wiring | Runs async; does NOT block next turn if checker slow (>3s → defer to turn+1) | 50 | SPEC-142 |
| T4 | Prompt fragment injector | Next-turn system message "since your last edit, tsc reports: …" | 30 | SPEC-105 |
