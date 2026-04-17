# Spec Changelog

Chronological record of spec-level decisions. Format: `YYYY-MM-DD @owner: decision + reason`.

## 2026-04-17 — v0.3.20-alpha SPEC-309: eager ChannelRuntime wiring (fix TelegramStatus "channel service not available")

- @hiepht: **Symptom** — user on v0.3.19-alpha confirmed tool `TelegramStatus`
  through the picker; tool ran but returned `"Telegram: channel service
  not available in this context"`. Agent interpreted as "I can't access
  Telegram" and gave up.
- @hiepht: **Root cause** — SPEC-833 introduced the `ChannelService` port
  in `src/core/channelPorts.ts`. `registerChannelService()` is called
  inside `createRuntime()` in `src/channels/runtime.ts`. The CLI REPL
  (`src/channels/cli/repl.ts`) only called `getChannelRuntime()` at
  shutdown (line 333), never at startup — so the runtime singleton was
  null and the port was never registered. `TelegramStatus.handler`
  (`src/tools/builtin/Telegram.ts:201`) saw `getChannelService() === null`
  and took the friendly-fallback branch that emitted the stub string.
- @hiepht: **Fix** — single eager `getChannelRuntime()` call at REPL
  boot, right before `setTelegramRuntimeBridge(...)`. `createRuntime()`
  is a pure factory (no adapter start, no network), so this is free.
  Regression test `tests/tools/telegram.test.ts` proves fresh-runtime
  path returns real status, and documents the pre-fix fallback shape so
  a future refactor cannot silently reintroduce the gap.
- @hiepht: **Why not Option C (vault-direct read in tool)** — would have
  re-introduced a `tools → channels/vault` edge that SPEC-833 just
  removed; and the runtime's `getTelegramStatus` already reads
  `readSummary()` from the vault while adapter is stopped, so the port
  already covers both cases. The bug was purely composition, not design.

## 2026-04-17 — v0.3.16-alpha URGENT: orphan tool_use sanitizer (fix P_INVALID_REQUEST 400 on replay)

- @hiepht: **Symptom** — user on v0.3.15 reported every REPL turn failing
  with `P_INVALID_REQUEST {status:400}` after typing `tiếp tục thử lại`.
  The turn never reached a tool call — provider rejected the request
  itself. v0.3.15 diff was picker-only (no provider/IR/loop changes), so
  the regression was NOT in v0.3.15 — it was a pre-existing latent bug
  surfaced because v0.3.14's picker UX had prevented the user from
  completing tool confirms cleanly, leaving the session JSONL with
  orphan `tool_use` blocks (assistant messages with `tool_use` but no
  matching `tool_result`).
- @hiepht: **Root cause** — both Anthropic and OpenAI REJECT any
  request where an assistant `tool_use` block has no matching
  `tool_result`. runTurn's existing executor pairs them mid-turn, but
  if the process dies, is killed (Ctrl-C x2), or aborts between
  `appendMessage(assistant-tool_use)` (loop.ts ~300) and
  `appendMessage(user-tool_result)` (loop.ts ~519), the JSONL persists
  an orphan. Every subsequent REPL boot rehydrates that orphan via
  `loadSession` → `priorMessages` → provider 400.
- @hiepht: **Fix (two layers, defense-in-depth)** —
  * `sanitizePriorMessages()` in `src/core/loop.ts`: runs BEFORE + AFTER
    `trimPriorMessages` on every turn's `priorMessages`. Walks the
    message list, tracks emitted `tool_use` ids, pairs them with
    `tool_result` blocks, and for any still-open id synthesises a
    `tool_result` stub (`isError:true`, content = "tool call
    interrupted — session resumed without a completed result").
    Preferred behaviour: merge stubs INTO the adjacent user-tool_result
    message (same turn — provider expects back-to-back). Fallback:
    insert a fresh synthetic user message right after the assistant.
    Also drops orphan `tool_result` blocks (no matching upstream
    `tool_use`) and empty assistant messages. Idempotent, pure (never
    mutates input).
  * `runTurn` catch block now scans the in-memory `conversation` for
    any orphan `tool_use` ids and persists a stub `tool_result` user
    message BEFORE re-throwing. Closes the write-crash window so
    future replays start clean.
- @hiepht: **Industry pattern** — mirrors Claude Code's
  `yieldMissingToolResultBlocks` (src/query.ts:123) which is invoked
  from THREE places in their turn loop: after model error (query.ts:984),
  after image error, and on abort (query.ts:1025). We do the
  equivalent on REPLAY + on crash catch — same contract, different
  insertion points because our loop persists eagerly whereas Claude
  Code streams.
- @hiepht: **Tests** —
  * `tests/core/sanitizePriorMessages.test.ts` — 10 unit cases
    (empty, paired, orphan-at-end, orphan-in-middle, parallel orphans,
    dropped orphan tool_result, partial pairing, idempotence,
    immutability, empty-assistant drop).
  * `tests/core/loopSanitize.test.ts` — end-to-end: inject orphan
    priorMessages, capture provider request with mock, assert the
    request seen by provider has the synthetic stub + user message
    paired correctly. Also asserts a fully-paired history passes
    through untouched (no regression on happy path).
- @hiepht: **Not a v0.3.15 regression** — the picker fix was correct
  and remains. The 400 is a latent bug from any prior version
  (v0.1.0-alpha onward) that produced orphan tool_use on any
  cancellation/crash scenario, finally triggered by the user's prior
  picker-driven aborts.
- @hiepht: Full test suite: 1990 pass, 0 fail. Typecheck clean.

## 2026-04-17 — v0.3.15-alpha URGENT: picker priming window against phantom keypress (5th regression)

- @hiepht: **Root cause (finally)** — the fifth picker regression (v0.3.10 →
  v0.3.14) was never in the parser. It was input bytes bleeding across the
  autocomplete→picker handoff. Trace evidence (repl-repro.ts): user types
  `lại xem\r` at the REPL, autocomplete's `onData('\r')` fires `enter`,
  resolves `readLine`, and calls `cleanup()` which toggles `setRawMode(false)`
  + `removeListener('data', onData)`. Between turns, stdin stays attached
  to the Node/Bun stream machinery; bytes that arrive (or that the kernel
  line-discipline re-releases when `setRawMode(true)` is later called by
  the picker) sit in the readable queue. When `confirmPick` then calls
  `emitKeypressEvents(input)` + `setRawMode(true)` + `resume()`, those
  queued bytes flush into the keypress decoder — the first event the
  picker sees is phantom. Screenshot A = phantom `return` → instant
  `allow`/`deny`. Screenshot B = phantom `down` events → cursor stuck on
  `Always`.
- @hiepht: **Fix (SPEC-901 v0.3.15)** — defense-in-depth in `pickOne`:
  (A) drain `input.read()` BEFORE attaching the keypress listener to
  evict any bytes already queued inside the Node readable's internal
  buffer, (B) 80ms PRIMING WINDOW — keypresses that arrive in the first
  80ms after listener attach are silently swallowed (no human can respond
  in <200ms; any key arriving that fast is necessarily a buffered
  leftover), (C) drain AGAIN after setRawMode(true)+resume() to catch
  bytes flushed by the kernel mode toggle. Parser unchanged (still
  `readline.emitKeypressEvents` — no more rolling our own).
- @hiepht: **Collateral fix in `slashAutocomplete`** — the paste branch
  (`data.length > 1`) previously swallowed a trailing `\r`/`\n` if an
  entire REPL line arrived in one chunk (fast IME / PTY scheduling),
  meaning Enter was never registered. Now split on newline inside
  `onData` paste handling and synthesise an enter.
- @hiepht: **Gate-B extension** — two new PTY smoke tests in
  `tests/onboard/picker.pty.smoke.test.ts` assert phantom Enter / Down
  arriving immediately after picker prompt render are swallowed and a
  subsequent legit Enter resolves correctly. Unit tests set
  `NIMBUS_PICKER_PRIMING_MS=0` so synthetic-stream tests still pass.
  PTY harness `scripts/pty-smoke/repl-repro*.ts` + python driver
  `scripts/pty-smoke/...py` reproduce the full REPL→picker race
  deterministically.
- @hiepht: 1955 non-HTTP tests pass, typecheck clean. Binary compiled
  + installed at `/root/.nimbus/bin/nimbus` (v0.3.15-alpha) and tested
  end-to-end: scenario 1-6 from user brief all PASS under real
  pseudo-terminal with `[picker-trace]` confirming priming absorbs
  phantom events without blocking legit keystrokes.

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
