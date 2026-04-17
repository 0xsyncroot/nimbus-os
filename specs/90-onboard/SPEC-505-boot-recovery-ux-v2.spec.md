---
id: SPEC-505
title: Boot vault recovery UX v2 — friendly prompt + enter-default fix
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3.9
layer: onboard
pillars: [P1, P6]
depends_on: [SPEC-152, SPEC-153, SPEC-904, META-009]
blocks: []
estimated_loc: 60
files_touched:
  - src/onboard/recoveryPrompt.ts
  - src/cli.ts
  - tests/onboard/recoveryPrompt.test.ts
  - tests/e2e/boot-recovery.test.ts
---

# Boot vault recovery UX v2 — friendly prompt + enter-default fix

## 1. Outcomes

- User hit by a vault-locked state on boot (corrupt envelope, passphrase mismatch, or post-v0.3.6 stale-key situation) sees a calm Vietnamese prompt with Enter-as-default = "fix it now", NOT a wall of English stack trace.
- The "fix it now" branch delegates into SPEC-904's shared interactive module — zero duplicated key-collection logic.
- Choosing "skip" cleanly exits with a short note (not a stack trace) + a one-line hint for `nimbus check`.
- Corrupt vault triggers a rotated backup before any overwrite attempt (leveraging SPEC-153) so recovery never destroys evidence.

## 2. Scope

### 2.1 In-scope
- Refactor `src/onboard/recoveryPrompt.ts` to render the new prompt text (Vietnamese, short, scanable).
- Change default action from "retry with env var" to "open interactive key manager from SPEC-904".
- Handle three input choices: `[Enter]` = fix, `s` = skip, `q` = quit.
- Add clean-exit message on `q` and `s` — no stack trace, exit code 2 on q / 0 on s.
- Pre-recovery backup: if vault envelope exists but is undecryptable, snapshot to `secrets.enc.bak-{ts}-corrupt` via SPEC-153 rotation before user-initiated write.

### 2.2 Out-of-scope (defer)
- Automatic vault repair via passphrase guessing → never (security).
- English translation of prompt → v0.4 i18n (SPEC-180) already handles locale; this spec writes in Vietnamese, i18n keys get added later.
- Cloud backup of `.bak-*corrupt` files → out of scope forever (user data sanctity).

## 3. Constraints

### Technical
- The prompt MUST flush to stdout before readline blocks — non-TTY stdin path must NOT block, it exits 2 with a hint.
- Fix path MUST call `runInteractiveKeyManager` from SPEC-904, not re-implement prompts.
- Skip path MUST NOT touch the vault file (no probes, no writes).
- No new passphrase derivation site — reuse `autoProvisionPassphrase`.

### Performance
- Prompt paint <20 ms.

### Resource / Business
- Copy must be clear enough that a non-technical user can act. Testable via UX review before approval.

## 4. Prior Decisions

- **Vietnamese-first copy** — primary user is VI speaker; English fallback deferred to SPEC-180. Better to be clear in one language now than awkward in both.
- **Enter-as-default = fix, not retry** — v0.3.8 default was "retry with env var" which re-faulted 9/10 times. "Fix it now" has higher success rate.
- **Reuse SPEC-904 module, don't fork** — the v0.3.6 bug was caused by three forked credential paths. This spec does NOT touch vault bytes directly.
- **Backup corrupt vault before any write** — if a user chooses Fix and the new key also fails to decrypt (unlikely but possible), the pre-existing broken state is preserved for forensic recovery. SPEC-153 rotation handles disk bounds.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Rewrite prompt text + key handling | Matches the canonical copy in §7 | 25 | SPEC-904 T1 |
| T2 | Wire fix path to `runInteractiveKeyManager` | Zero duplicate masking/probe code | 10 | SPEC-904 T2 |
| T3 | Skip/quit clean exits | No stack trace; exit codes 0 / 2 | 10 | T1 |
| T4 | Corrupt-envelope pre-backup hook | SPEC-153 `rotateBackups` called with `-corrupt` suffix | 10 | SPEC-153 T2 |
| T5 | Unit + E2E tests | See §6 | 30 | T2, T3, T4 |

## 6. Verification

### 6.1 Unit Tests
- `tests/onboard/recoveryPrompt.test.ts`:
  - Enter → calls interactive manager
  - `s` → exits 0 with "bỏ qua" note
  - `q` → exits 2 with "thoát" note
  - Non-TTY stdin → immediate exit 2 + hint text
  - Corrupt vault path → `secrets.enc.bak-*-corrupt` created before any write

### 6.2 E2E Tests
- `tests/e2e/boot-recovery.test.ts` (PTY):
  - Simulate v0.3.6 vault-clobbered state (vault file exists, decryption fails) → boot → see VI prompt → press Enter → interactive manager appears → enter valid key → REPL starts and chat works
  - Same state, press `s` → exit 0, stderr shows `nimbus check` hint, no stack trace
  - Same state, press `q` → exit 2, no writes

### 6.3 Performance Budgets
- Prompt <20 ms paint.

### 6.4 Security Checks
- No passphrase logged.
- No vault byte rewritten except via SPEC-904 path (which is probe-guarded).
- reviewer-security sign-off REQUIRED (boot-time credential UX).
- Upgrade regression: simulate pre-v0.3.9 state with two providers → boot recovery → fix → both providers still usable.

## 7. Interfaces

Canonical prompt copy (final, copy-tested):

```
Em không mở được API key đã lưu (vault bị khóa).

  [Enter]  Nhập lại key ngay (khuyến nghị)
  [s]      Bỏ qua, mở nimbus không có key
  [q]      Thoát

Chọn:
```

Clean-exit messages:

```
# after 's'
Đã bỏ qua. Chạy `nimbus check` khi em sẵn sàng để chẩn đoán.

# after 'q'
Đã thoát. Không thay đổi gì.
```

```ts
export interface RecoveryInput {
  readonly reason: 'corrupt' | 'locked' | 'missing_key' | 'passphrase_mismatch';
  readonly path: string;
}

export async function runRecoveryPrompt(
  input: RecoveryInput,
  opts: { readonly tty: boolean },
): Promise<boolean>; // true = handled (proceed to REPL), false = caller should exit 2
```

## 8. Files Touched

- `src/onboard/recoveryPrompt.ts` (edit, ~45 LoC delta)
- `src/cli.ts` (minor — adjust exit-code handling for `false` return, ~5 LoC)
- `tests/onboard/recoveryPrompt.test.ts` (edit, ~40 LoC added)
- `tests/e2e/boot-recovery.test.ts` (new, ~60 LoC)

## 9. Open Questions

- [ ] Should the "bỏ qua" path start REPL in read-only mode (no provider calls) or exit entirely? — Propose EXIT 0 for v0.3.9 (simpler); read-only REPL deferred to v0.4.

## 10. Changelog

- 2026-04-17 @hiepht: draft (v0.3.9 — close the loop on v0.3.6 post-mortem; calm UX + shared module reuse)
