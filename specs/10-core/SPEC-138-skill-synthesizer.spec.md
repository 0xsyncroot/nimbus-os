---
id: SPEC-138
title: SkillSynthesizer — draft SKILL.md from pattern, user confirm
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: core
pillars: [P3, P7, P8]
depends_on: [SPEC-137, SPEC-310, SPEC-320, SPEC-140, SPEC-144]
blocks: []
estimated_loc: 350
files_touched:
  - src/skills/synthesizer/drafter.ts
  - src/skills/synthesizer/confirmFlow.ts
  - src/skills/synthesizer/register.ts
  - tests/skills/synthesizer/drafter.test.ts
  - tests/e2e/skill-synthesis.test.ts
---

# SkillSynthesizer — Draft SKILL.md from Pattern, User Confirm

## 1. Outcomes

- When SPEC-137 PatternObserver emits a `pattern.candidate`, SkillSynthesizer drafts a `SKILL.md` (frontmatter + trigger hints + procedure steps) from the sequence + recent context, runs SPEC-310 analyzer, and — on user confirm via SPEC-144 plan-diff UI — registers it in the skill loader.
- Output is a YAML-front-matter markdown file following the same template as bundled skills; user can edit the draft before approving.
- Uses TrustLedger (SPEC-140) to track synthesized skills with rollback path.
- Covers P7 (skill synthesis) and extends P8 multi-domain because the pattern corpus reflects whatever the user actually does — not just dev-centric bundled skills.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Drafter prompt + LLM call | Produces valid SKILL.md for 5 fixture bigram patterns; skill loader accepts it | 120 | SPEC-320 |
| T2 | Analyzer pass (origin=self) | 9 risk dims; fail cases block registration | 50 | SPEC-310 |
| T3 | Confirm flow via SPEC-144 plan-diff UI | User sees draft, can edit in $EDITOR, then confirm | 70 | SPEC-144 |
| T4 | Register + TrustLedger entry | Skill activated next session; ledger records synthesis | 60 | SPEC-140, SPEC-320 |
| T5 | Session rate limit + cost attribution | Max 1 synthesis per session (LLM call ~$0.01); costEvent trigger='skill-synth' | 50 | SPEC-701 |
