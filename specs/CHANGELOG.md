# Spec Changelog

Chronological record of spec-level decisions. Format: `YYYY-MM-DD @owner: decision + reason`.

## 2026-04-16 — v0.3.4-alpha URGENT: 3 user-caught regressions

- @hiepht: **Bug A (SPEC-826 v0.2)** — `⋯ đang writing {path}` VN/EN hybrid
  leak on servers with `LANG=C.UTF-8` (locale defaults to `en` but renderer
  hardcoded the VN `đang ` prefix). Fix: label map owns its verb; renderer is
  locale-agnostic. Also added missing tool aliases (MultiEdit, NotebookEdit,
  Ls, Bash `cmd` key) to prevent unknown-tool fallback path.
- @hiepht: **Bug B (SPEC-825 v0.2)** — confirm `y` then generic
  "Tool failed — run with `--verbose`". Two defects: (1) `gate.ts` only
  checked `rememberAllow` cache inside the `ruleDecision === 'ask'` branch,
  never the destructive-tool fallback; (2) `loopAdapter` only populated cache
  on `'always'`, not `'allow'`. Fixed both; `'allow'`/`'always'` are
  session-equivalent in v0.3 (v0.4 splits them via persistence).
  Bonus: renderer now extracts `errorCode` from `ToolResult.content` so the
  friendly formatter picks a per-code sentence instead of the generic
  fallback. Removed `--verbose` dev-hint from the default user-facing
  message.
- @hiepht: **Bug C (SPEC-124 v0.2)** — agent claimed `"em đã nhận token"`
  after Write tool returned error (hallucination on tool failure). Fix:
  `CREDENTIAL_HANDLING_SECTION` now carries a "TRUTHFULNESS ON TOOL FAILURE"
  hard-rule clause: `isError: true` ⟹ credential NOT saved ⟹ agent must
  state failure plainly; no "đã nhận / saved"; no user-paste-workaround.

## 2026-04-15 — Project Bootstrap

- @hiepht: Adopted **Spec-Driven Development** (spec-first + spec-anchored). Reason: 1-dev + AI-assisted workflow requires durable truth.
- @hiepht: Scaffolded spec folder structure `/specs/{00-meta,10-core,15-platform,...}`.
- @hiepht: Drafted 6 meta specs + 22 feature specs for v0.1.
- @hiepht: Chose `playwright-core` Chromium-only for v0.4 browser tool. Reason: -1GB vs full Playwright; personal OS doesn't need multi-browser.
- @hiepht: Chose JSONL over SQLite for primary session storage. Reason: append-only crash-safe, grep/jq-friendly debug, 1-user scan 30d <1s.
- @hiepht: Platform abstraction from v0.1 (not retrofit). Reason: 3× effort later, Win/macOS/Linux CI matrix from day 1.
- @hiepht: Deferred cost enforcement to v0.2 (v0.1 track only). Reason: realistic 4200 LoC scope for v0.1.
- @hiepht: Plugin system moved to v0.5 (from v0.4). Reason: security hardening — signed allowlist only.
- @hiepht: Channel auth designed from v0.3 (bearerToken + pairing + allowlist). Reason: ship v0.3 channels without auth = hijackable.
- @hiepht: `/api/v1/*` namespace from v0.3. Reason: mobile-ready versioning, avoid breaking change later.
- @hiepht: Mobile strategy = Approach D (channels) + B (PWA), React Native only v1.0+. Reason: leverage existing Telegram/Slack/iMessage infra.
- @hiepht: Dreaming timezone = local TZ default, DST skip (safe). Reason: user VN bị interrupt 10 AM nếu UTC.
- @hiepht: i18n en+vi from v0.2. Reason: user primary Vietnamese.
- @hiepht: Self-healing = conservative + dry-run for FixSkill. Reason: trust LLM diagnose có rủi ro.
