---
id: SPEC-139
title: LearningEngine — scan history + propose SOUL/MEMORY diff
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: core
pillars: [P3, P4]
depends_on: [SPEC-112, SPEC-114, SPEC-141, SPEC-134, SPEC-140, SPEC-144]
blocks: []
estimated_loc: 400
files_touched:
  - src/core/learning/engine.ts
  - src/core/learning/historyScanner.ts
  - src/core/learning/diffProposer.ts
  - tests/core/learning/engine.test.ts
  - tests/e2e/learning-engine.test.ts
---

# LearningEngine — Scan History + Propose SOUL/MEMORY Diff

## 1. Outcomes

- Runs weekly (via SPEC-134 cron) over last N sessions' summaries + user feedback signals (reactions, `/thanks`, `/retry` commands) and proposes concrete diffs: SOUL.md voice tweaks, MEMORY.md durable-fact additions, TOOLS.md deprecations.
- All proposals go through SPEC-144 plan-diff UI — user confirms/edits/rejects each hunk; approvals recorded in TrustLedger (SPEC-140).
- Extends SPEC-112 Dreaming Lite (session-local consolidation) and replaces SPEC-114 Reflection Journal draft (merged here).
- Measurable: at least one user-accepted SOUL edit per month of use on a medium-active workspace; otherwise the engine is disabled + flagged for redesign.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | History scanner (sessions N=30, feedback events) | Produces compact digest ≤8KB | 90 | SPEC-102, SPEC-141 |
| T2 | Diff proposer (LLM pass, structured JSON output) | Returns typed diff-set for SOUL / MEMORY / TOOLS | 130 | SPEC-202 |
| T3 | Plan-diff UI integration | Each hunk individually approve/reject/edit | 70 | SPEC-144 |
| T4 | Apply + TrustLedger record | Atomic write with fcntl lock; ledger entry per applied hunk | 60 | SPEC-140, SPEC-304 |
| T5 | Cron job @weekly + cost cap ($0.10/run) | Skips when workspace cost for week already >$2 | 50 | SPEC-134, SPEC-702 |
