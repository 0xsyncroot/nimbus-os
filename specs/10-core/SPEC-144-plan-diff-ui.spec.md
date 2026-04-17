---
id: SPEC-144
title: Plan-diff UI for write-tier + tool-register
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: core
pillars: [P6, P9]
depends_on: [SPEC-142, SPEC-825, SPEC-404, SPEC-801, SPEC-803]
blocks: []
estimated_loc: 250
files_touched:
  - src/channels/cli/planDiff.ts
  - src/channels/telegram/planDiff.ts
  - src/core/hooks/registry.ts
  - tests/channels/cli/planDiff.test.ts
---

# Plan-diff UI for Write-tier + Tool-register

## 1. Outcomes

- Before a write-tier tool call (`Write`, `Edit`, `MemoryTool.append`) OR a register call (tool synthesis via SPEC-136, skill synthesis via SPEC-138, SOUL/MEMORY diff via SPEC-139), the user sees a structured diff view (not just a `y/n` prompt) with file paths + hunks + line counts.
- Rendered for CLI (ANSI side-by-side) and Telegram (unified diff in code block with inline approve/edit/cancel buttons).
- Closes the P6 "tự review" loop — user sees EXACTLY what the agent will change before it lands.
- Orthogonal to SPEC-825 confirm flow: confirm is the gate, plan-diff is the payload being shown at the gate.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Diff builder (file-before/after → hunks) | Uses diff-match-patch or `node:diff`; handles new-file + delete | 80 | — |
| T2 | CLI renderer (ANSI coloured side-by-side) | Respects `NO_COLOR`; wraps at terminal width | 70 | SPEC-801 |
| T3 | Telegram renderer (unified in code block + 3 inline buttons) | Approve/Edit/Cancel map to callback queries | 50 | SPEC-803 |
| T4 | Hook registration (preToolUse on write-tier + register paths) | Gate fires; user response resolves back to hook verdict | 50 | SPEC-142 |
