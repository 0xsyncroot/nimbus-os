# Spec Changelog

Chronological record of spec-level decisions. Format: `YYYY-MM-DD @owner: decision + reason`.

## 2026-04-17 — v0.3.14-alpha URGENT: picker stop rolling own keystroke parser

- @hiepht: **SPEC-901 v0.3.14 rewrite** — after four consecutive TTY picker
  regressions shipped in v0.3.10 (double echo "yy") → v0.3.11 (race between
  autocomplete cleanup and rawMode enable) → v0.3.12 (shortcut leaked on
  stray buffered byte) → v0.3.13 (bespoke `parseKeys` mishandled chunk-split
  ANSI escapes so an arrow occasionally landed on the wrong action), replace
  the hand-rolled chunk parser with `readline.emitKeypressEvents(stream)` —
  the same reference keypress parser Claude Code uses via ink's `useInput`,
  used by every major interactive Node CLI. This gets us for free: ANSI
  escape parsing across chunk boundaries, correct UTF-8 grouping (so
  Vietnamese "nhỉ" combining marks don't fire stray shortcuts), Ctrl+key
  recognition via `key.ctrl`, and idempotent setup (safe when autocomplete
  already touched stdin during the same REPL turn). Decision rationale: we
  were rediscovering bugs that Node solved in 2013; rolling-own was
  premature optimisation for 30 LoC of "saving a dep" that cost four
  shipped broken releases in a week. Unknown keypresses are now explicitly
  ignored rather than optimistically routed through shortcut tables —
  conservative by default.
- @hiepht: **New Gate-B harness** — `tests/onboard/picker.pty.smoke.test.ts`
  allocates a real pseudo-terminal via libc (`posix_openpt` / `grantpt` /
  `unlockpt` / `ptsname` through Bun FFI), spawns the picker harness with
  stdio bound to the slave, and drives real ANSI sequences from the master
  fd. Covers the exact four regressions plus chunk-split ESC arrival and
  arrow clamping. Mock-Readable unit tests proved insufficient four
  releases in a row; PTY smoke is now the gate for any picker change.

## 2026-04-16 — v0.3.7-alpha URGENT: binary-upgrade silently locks existing vault

- @hiepht: **Bug V1 (SPEC-152 / SPEC-901 v0.2.1 hardening)** —
  `autoProvisionPassphrase` used to auto-generate a random passphrase and
  write it to `~/.nimbus/.vault-key` whenever no passphrase source was
  available, even if an encrypted vault already existed. On binary upgrade
  (user had set `NIMBUS_VAULT_PASSPHRASE` in v0.3.4, opened a new shell
  without it on v0.3.6), this permanently masked the correct passphrase.
  Decision: autoProvision is now vault-aware — it probes the candidate
  passphrase against the existing envelope before accepting, and raises
  `X_CRED_ACCESS / vault_locked` rather than silently generating. First-run
  path (no vault yet) unchanged. Trade-off: users who legitimately lost the
  passphrase are blocked by the guard until they run `nimbus vault reset`,
  which backs up the old vault to `secrets.broken-<ts>.enc` and
  re-provisions. This is the correct safety default — we cannot silently
  destroy user key material.
- @hiepht: **Bug V2 (SPEC-902)** — `resolveProviderKey` swallowed every
  secret-store error with a bare `try/catch`, masking wrong-passphrase
  failures as `U_MISSING_CONFIG: provider_key_missing`. Decision: only
  `T_NOT_FOUND` is benign; every other error (including `X_CRED_ACCESS`
  and `S_STORAGE_CORRUPT`) now propagates so the user sees the real cause.
- @hiepht: **UX polish (SPEC-826)** — new `formatBootError` maps provider
  init errors to 1-line VN/EN sentence + `→` hint. Raw JSON context is
  demoted to `logger.warn` only (no stdout). The REPL pre-warns at boot
  when `autoProvisionPassphrase` raises `vault_locked` so the user does
  not have to type a message just to discover the vault is locked.
- @hiepht: **QA retrospective** — v0.3.6 smoke tests did not exercise the
  binary + real-vault + real-key upgrade path. Added
  `tests/e2e/binaryUpgradeSmoke.test.ts` (spawns the compiled binary,
  replicates the exact user scenario). Rule going forward: every alpha tag
  must smoke at least one "existing-state + binary swap" scenario.

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
