---
id: SPEC-137
title: PatternObserver — bigram tool-sequence dedup
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.5
layer: core
pillars: [P3, P7]
depends_on: [SPEC-119, SPEC-134, SPEC-118]
blocks: [SPEC-138]
estimated_loc: 220
files_touched:
  - src/core/patternObserver/observer.ts
  - src/core/patternObserver/bigram.ts
  - tests/core/patternObserver/observer.test.ts
---

# PatternObserver — Bigram Tool-Sequence Dedup

## 1. Outcomes

- Watches tool-call sequences across sessions; when the same bigram pattern (pair of consecutive tool calls) appears ≥N times within a sliding window (N=3, window=7 days), emits a `pattern.candidate` event with the sequence, frequency, and last-N timestamps.
- Feeds SPEC-138 SkillSynthesizer: candidate patterns become "should we skill-ify this?" suggestions.
- Starts with bigrams (per mediator ruling); promotes to trigrams in v0.6 only if skill-precision measured <40%.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Subscribe to tool-use audit events + tokenize into bigrams | Skips hooks/system tools; handles inter-session boundaries | 60 | SPEC-119 |
| T2 | Sliding-window counter (7d, file-backed) | Correct expiry; rehydrates on restart | 80 | SPEC-151 |
| T3 | Threshold trigger + event emit | `pattern.candidate` emitted on N-th occurrence, not every time | 40 | T2, SPEC-118 |
| T4 | Cron job entry: periodic window roll + compaction | Runs `@daily` via SPEC-134 | 40 | SPEC-134 |
