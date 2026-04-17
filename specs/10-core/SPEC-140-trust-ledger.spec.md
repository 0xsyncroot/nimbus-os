---
id: SPEC-140
title: TrustLedger — signed append-only registry of self-written artifacts
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.4
layer: core
pillars: [P4, P5]
depends_on: [SPEC-119, SPEC-152, META-009]
blocks: [SPEC-136, SPEC-138]
estimated_loc: 200
files_touched:
  - src/core/trustLedger/ledger.ts
  - src/core/trustLedger/hashChain.ts
  - tests/core/trustLedger/ledger.test.ts
---

# TrustLedger — Signed Append-only Registry of Self-written Artifacts

## 1. Outcomes

- Every self-written tool, skill, or SOUL/MEMORY diff that the agent proposes (and the user approves) gets a ledger entry with `artifactId`, `kind`, `contentHash`, `parentHash`, `approvedBy`, `approvedAt`.
- Hash chain detects tamper: changing any past entry breaks the chain, surfaced on next verify.
- Supports `unregister(artifactId)` — records tombstone entry (never physical delete) so history is preservable.
- Enables "show me every tool nimbus wrote itself in last 30 days" + forensic trace when a self-written artifact causes regression.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | JSONL ledger schema + append | `~/.nimbus/workspaces/<id>/trust-ledger.jsonl`; 0600; atomic append | 50 | SPEC-151 |
| T2 | HMAC chain (workspace key from SPEC-152) | Each entry has `prevHash` + `hmac(entry || prevHash)`; verify-all <100ms for 1000 entries | 60 | SPEC-152 |
| T3 | `record/tombstone/verify/query` API | Append record; append tombstone; verify chain; query by artifactId/kind/timeRange | 60 | T1, T2 |
| T4 | Integration: ToolBuilder + SkillSynthesizer + LearningEngine call `record()` | 3 call sites, tests assert ledger line added | 30 | T3 |
