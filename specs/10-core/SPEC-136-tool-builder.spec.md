---
id: SPEC-136
title: ToolBuilder — synthesize + sandbox-test + register tool
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P5, P4]
depends_on: [SPEC-135, SPEC-310, SPEC-303, SPEC-401, SPEC-140, META-009]
blocks: []
estimated_loc: 500
files_touched:
  - src/core/toolBuilder/synthesizer.ts
  - src/core/toolBuilder/sandboxRunner.ts
  - src/core/toolBuilder/registrar.ts
  - src/core/toolBuilder/template.ts
  - tests/core/toolBuilder/synthesizer.test.ts
  - tests/e2e/tool-synthesis.test.ts
---

# ToolBuilder — Synthesize + Sandbox-Test + Register Tool

## 1. Outcomes

- When ToolGapDetector (SPEC-135) returns `action: 'synthesize'`, the builder drafts a new tool (TS module + Zod schema + description) from a template, runs it through the SPEC-310 analyzer (9 risk dims, internal-origin branch), sandboxes a smoke run, and — on user confirm — registers it at runtime.
- Self-written tools are recorded in SPEC-140 TrustLedger so they can be audited, versioned, rolled back, or uninstalled.
- Per-session cap: max 3 successful registrations; max 2 attempts per gap before giving up.
- Completes Expert B's "propose-don't-autonomously-apply" principle.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Template + synthesizer prompt | Produces TS module matching `Tool` contract (SPEC-301) + Zod schema; compiles first-try ≥70% fixtures | 110 | SPEC-301 |
| T2 | Analyzer integration (internal-origin) | Reuses `skills/registry/analyzer.ts`; adds `origin: 'self'` branch with stricter rules (no network w/o approval) | 80 | SPEC-310 |
| T3 | Sandbox runner | Runs tool in worker thread with fake args + deny-network; captures stdout/stderr; reports pass/fail | 130 | SPEC-303 |
| T4 | Registrar + rollback | On user confirm: `registry.register(toolSpec)`; also records in TrustLedger (T5); `unregister` symmetric | 90 | SPEC-310, SPEC-140 |
| T5 | Session rate limits + cost attribution | 3 success / 2 attempt caps; costEvent trigger='tool-synthesis' | 50 | SPEC-701 |
| T6 | CLI confirm UI (diff view of generated code) | User sees code + risk report + sandbox result; y/n confirm | 40 | SPEC-801 |
